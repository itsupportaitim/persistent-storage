// @ts-nocheck
// index.ts
import { getAuthToken } from "./services/auth.ts";
import { getCompanies, filterCompanies } from "./services/companies.ts";
import { writeJSON } from "./services/file.ts";
import { fetchAllCompaniesDrivers } from "./services/fetchAllCompaniesDrivers.ts";
import { filterInactiveDrivers } from "./services/filterInactiveDrivers.ts";

import { createClient } from "npm:@supabase/supabase-js@2";
import { removeDriverFields } from "./services/removeDriverFields.ts";

// --------------------------
// Retry Utility
// --------------------------
async function retryWithAlert<T>(fn: () => Promise<T>, fnName: string, maxRetries = 3, delayMs = 1000): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[${fnName}] Attempt ${attempt}/${maxRetries}...`);
      const result = await fn();

      if (attempt > 1) {
        console.log(`✅ [${fnName}] Succeeded on attempt ${attempt}`);
      }

      return result;
    } catch (err: any) {
      lastError = err;
      console.error(`❌ [${fnName}] Attempt ${attempt} failed:`, err.message);

      if (attempt === maxRetries) {
        console.error(`🚨 [${fnName}] Failed after ${maxRetries} attempts`);
        throw new Error(`${fnName} failed after ${maxRetries} attempts: ${err.message}`);
      }

      const waitTime = delayMs * Math.pow(2, attempt - 1);
      console.log(`⏳ Waiting ${waitTime}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  throw lastError;
}

// --------------------------
// Main Edge Function
// --------------------------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const startTime = Date.now();
  const TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes (less than orchestrator's 30min timeout)

  // Only handle GET requests on root path
  if (req.method === "GET") {
    try {
      const username = Deno.env.get("HEROELD_USERNAME");
      const password = Deno.env.get("HEROELD_PASSWORD");
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

      if (!username || !password) {
        return new Response(JSON.stringify({ success: false, error: "Missing credentials" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (!supabaseUrl || !supabaseKey) {
        return new Response(JSON.stringify({ success: false, error: "Missing Supabase credentials" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Initialize Supabase client inside request handler
      const supabase = createClient(supabaseUrl, supabaseKey);

      // Create timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Hero function timeout after 25 minutes")), TIMEOUT_MS);
      });

      // Wrap all processing in a promise to race against timeout
      const processingPromise = (async () => {
        // 1️⃣ Authenticate
        const token = await retryWithAlert(() => getAuthToken(username, password), "Authentication", 3, 1000);

        // 2️⃣ Fetch companies
        const companiesRaw = await retryWithAlert(() => getCompanies(token), "Fetch Companies", 3, 2000);

        // 3️⃣ Filter companies
        const companiesFiltered = filterCompanies(companiesRaw);

        // 4️⃣ Save filtered companies
        await writeJSON("/tmp/companies_filtered.json", companiesFiltered);

        // 5️⃣ Fetch drivers for each company (parallel batch processing)
        const driversFetchResult = await retryWithAlert(
          () => fetchAllCompaniesDrivers({
            companiesFile: "/tmp/companies_filtered.json",
            outFile: "/tmp/companies_with_drivers.json",
            batchSize: 10 // Process 10 companies in parallel
          }),
          "Fetch All Drivers",
          3,
          3000
        );

        // 6️⃣ Filter inactive drivers
        const activeCompanies = await filterInactiveDrivers("/tmp/companies_with_drivers.json", "/tmp/standardized.json");
        await removeDriverFields("/tmp/standardized.json", "/tmp/finalversion.json");

        // 7️⃣ Upload to Supabase storage
        const finalData = await Deno.readTextFile("/tmp/finalversion.json");
        const { error: uploadError } = await supabase.storage.from("arc").upload("hero.json", new Blob([finalData]), {
          upsert: true
        });
        if (uploadError) throw uploadError;
        console.log(`✅ Uploaded hero.json to bucket arc`);
        const executionTime = Date.now() - startTime;

        return {
          success: true,
          message: "Companies fetched, filtered, drivers fetched, and inactive drivers removed",
          metrics: {
            companiesFiltered: companiesFiltered.length,
            companiesProcessed: driversFetchResult.processed,
            companiesWithErrors: driversFetchResult.errors,
            totalDriversFetched: driversFetchResult.drivers,
            activeCompaniesCount: activeCompanies.length,
            executionTimeMs: executionTime,
            executionTimeSec: Math.round(executionTime / 1000),
          }
        };
      })();

      // Race processing against timeout
      const result = await Promise.race([processingPromise, timeoutPromise]);

      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });

    } catch (err: any) {
      console.error("❌ Request failed:", err);
      return new Response(JSON.stringify({
        success: false,
        error: err.message,
        executionTimeMs: Date.now() - startTime,
      }, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // For all other paths or methods, return 404
  return new Response(JSON.stringify({ error: "Not Found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
});
