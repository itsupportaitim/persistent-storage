// @ts-nocheck


// services/fetchAllCompaniesDrivers.ts

// --------------------------
// Environment Variables
// --------------------------
const AUTH_URL = "https://backend.apexhos.com/authentication";
const DRIVERS_URL = "https://backend.apexhos.com/drivers";

const USERNAME = Deno.env.get("HEROELD_USERNAME");
const PASSWORD = Deno.env.get("HEROELD_PASSWORD");

if (!USERNAME || !PASSWORD) {
  throw new Error("Missing HEROELD_USERNAME or HEROELD_PASSWORD in environment");
}

// --------------------------
// Helpers
// --------------------------
export function basicAuthHeader(username: string, password: string): string {
  return "Basic " + btoa(`${username}:${password}`); // Deno/Web base64
}

export async function retry<T>(
  fn: () => Promise<T>,
  { attempts = 5, initialDelayMs = 1000 } = {},
): Promise<T> {
  let attempt = 0;
  let delay = initialDelayMs;
  while (attempt < attempts) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;

      // Check if this is a 429 rate limit error
      const is429 = err.message?.includes('429') || err.message?.includes('Too Many Requests');

      if (attempt >= attempts) throw err;

      // Use longer delays for 429 errors
      const waitTime = is429 ? delay * 3 : delay;

      console.log(`⏳ Retry ${attempt}/${attempts} after ${waitTime}ms delay${is429 ? ' (rate limited)' : ''}...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      delay *= 2;
    }
  }
  throw new Error("Retry failed"); // fallback
}

// --------------------------
// Auth & Drivers
// --------------------------
export async function getCompanyToken(companyId: string): Promise<string> {
  const body = {
    company: companyId,
    email: USERNAME,
    password: PASSWORD,
    rCode: "hero",
    strategy: "local",
  };

  const res = await retry(() =>
    fetch(AUTH_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(USERNAME!, PASSWORD!),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`Auth failed for company ${companyId}: ${res.status} ${res.statusText} - ${text}`);
  }

  const json = await res.json().catch(() => ({}));
  const token = json?.accessToken || json?.token || json?.data?.token || json?.data?.accessToken;
  if (!token) throw new Error(`No token found in auth response for company ${companyId}`);
  return token;
}

export async function getDriversForCompany(token: string): Promise<any[]> {
  const res = await retry(() =>
    fetch(DRIVERS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }),
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`Drivers fetch failed: ${res.status} ${res.statusText} - ${text}`);
  }

  const json = await res.json().catch(() => ({}));
  return Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];
}

export function filterDrivers(rawDrivers: any[]): any[] {
  return rawDrivers
    .filter((d) => {
      // Must have appVersion
      if (!d.appVersion) return false;

      return true;
    })
    .map((d) => ({
      firstName: d.firstName ?? d.firstname ?? d.first_name ?? null,
      lastName: d.lastName ?? d.lastname ?? d.last_name ?? null,
      vehicle: d.driverInfo.avi[0] ?? null,
      eldId: d._id ?? null,
      active: typeof d.active === "boolean" ? d.active : !!d.active,
      updatedAt: d.updatedAt,
    }));
}

// --------------------------
// Main function to fetch all companies' drivers
// --------------------------
export async function fetchAllCompaniesDrivers({
  companiesFile = "/tmp/companies_filtered.json",
  outFile = "/tmp/finalversion.json",
  sequential = false,
  batchSize = 5,
  onProgress,
} = {}): Promise<{ total: number; processed: number; errors: number; drivers: number }> {
  const raw = await Deno.readTextFile(companiesFile);
  const companies = JSON.parse(raw);
  if (!Array.isArray(companies)) throw new Error("Companies file must be an array");

  const result: any[] = [];
  const skipIds = new Set(["Company:5mJ7qXBDpF",
    "Company:HzUoAVDW0_", "Company:WMGn_7x8-H", "Company:jcBwjyzKIfk", "Company:YjyXd8_nf_r",
    "Company:YduLfv8Fbzb", "Company:Wf87FzbmCKW", "Company:UHojVXuOYH", "Company:QGq1MSv9Ufl",
    "Company:P5nDm7NkXjt", "Company:Ki5r52qA5to", "Company:DNye1iiuGUW",
    "Company:A3B8tVprpCS", "Company:9vE6CWMe_gU", "Company:t1c-41MEMb", "Company:sDDZMEfBETH",
    "Company:odZYUeailIW", "Company:xxZpCvV7NCp", "Company:y0VBQfjT7GC", "Company:ywIp7mhs8pj",
    "Company:xf_KvDrpg2u", "Company:vjnuaeUTuow"
  ]);

  // Filter out skipped companies upfront
  const validCompanies = companies.filter(c => {
    const companyId = c.companyId ?? c.id ?? c.company_id;
    return companyId && !skipIds.has(companyId);
  });

  const totalCompanies = validCompanies.length;
  let processedCount = 0;
  let errorCount = 0;

  console.log(`📊 Processing ${totalCompanies} companies in batches of ${batchSize}`);

  // Process companies in parallel batches
  for (let i = 0; i < validCompanies.length; i += batchSize) {
    const batch = validCompanies.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(validCompanies.length / batchSize);

    console.log(`🔄 Batch ${batchNum}/${totalBatches}: Processing ${batch.length} companies...`);

    const batchPromises = batch.map(async (company, idx) => {
      const companyId = company.companyId ?? company.id ?? company.company_id;
      const companyName = company.name ?? company.companyName ?? company.company_name;
      const globalIdx = i + idx + 1;

      // Add staggered delay within batch to avoid parallel request spikes
      await new Promise((r) => setTimeout(r, idx * 300));

      try {
        const token = await getCompanyToken(companyId);
        // Small delay between auth and drivers request
        await new Promise((r) => setTimeout(r, 200));
        const driversRaw = await getDriversForCompany(token);
        const drivers = filterDrivers(driversRaw);

        console.log(`✅ [${globalIdx}/${totalCompanies}] ${companyName}: ${drivers.length} drivers`);
        return { eldPlatform: "HERO", companyId, name: companyName || null, drivers };
      } catch (err: any) {
        console.error(`❌ [${globalIdx}/${totalCompanies}] ${companyName}: ${err.message}`);
        errorCount++;
        return { companyId, name: companyName || null, drivers: [], _error: err.message };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    result.push(...batchResults);
    processedCount += batch.length;

    // Save progress snapshot after each batch
    await Deno.writeTextFile(outFile, JSON.stringify(result, null, 2));

    // Report progress
    const progressPercent = Math.round((processedCount / totalCompanies) * 100);
    const totalDrivers = result.reduce((sum, c) => sum + (c.drivers?.length || 0), 0);
    console.log(`📈 Progress: ${processedCount}/${totalCompanies} (${progressPercent}%) | Drivers: ${totalDrivers} | Errors: ${errorCount}`);

    if (onProgress) {
      onProgress({ processed: processedCount, total: totalCompanies, errors: errorCount, drivers: totalDrivers });
    }

    // Delay between batches to avoid overwhelming the API
    if (i + batchSize < validCompanies.length) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const totalDrivers = result.reduce((sum, c) => sum + (c.drivers?.length || 0), 0);
  await Deno.writeTextFile(outFile, JSON.stringify(result, null, 2));
  console.log(`✅ Done. Processed ${processedCount}/${totalCompanies} companies | Drivers: ${totalDrivers} | Errors: ${errorCount}`);

  return { total: totalCompanies, processed: processedCount, errors: errorCount, drivers: totalDrivers };
}