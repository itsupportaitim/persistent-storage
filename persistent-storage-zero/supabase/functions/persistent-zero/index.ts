// @ts-nocheck
// index.ts
/**
 * Supabase Edge Function: login -> get ALL companies (paginated) -> fetch drivers -> upload to Storage 'arc'
 *
 * Env (add via supabase secrets or dashboard):
 *  USERNAME, PASSWORD, DEVICE_ID, DEVICE_NAME, LOCATION_TEXT, IP, LAT, LON
 *  Optional for upload: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const SIGN_IN_URL = Deno.env.get("API_URL") ?? "https://cloud.zeroeld.us/rest/rpc/sign_in_v2";
const COMPANIES_BASE_URL = "https://cloud.zeroeld.us/rest/company";

function getEnv(name) {
  return Deno.env.get(name) ?? "";
}

async function login() {
  const body = {
    parameters: {
      device_id: "fd1a5cccc08ff8631881573f76073d7a",
      device_name: "Windows NT 10.0 Chrome 139.0.0.0",
      location_text: "Kirgizskaya akademiya Obrazovaniya, 25, Erkindik Boulevard, Bishkek City, 720040, Kyrgyzstan",
      ip: "77.235.28.135",
      location_lat: "42.869923",
      location_lon: "74.6070909"
    },
    username: Deno.env.get("USERNAME"),
    password: Deno.env.get("PASSWORD")
  };

  const resp = await fetch(SIGN_IN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Login failed: ${resp.status} ${resp.statusText} - ${txt}`);
  }

  const json = await resp.json();
  const token = json?.token || json?.data?.token || json?.access_token || json?.accessToken || json?.session?.access_token;
  if (!token) throw new Error("No token found in login response: " + JSON.stringify(json));
  return token;
}

async function fetchAllCompanies(token) {
  const allCompanies = [];
  let offset = 0;
  const limit = 100; // Fetch 100 at a time for efficiency
  
  while (true) {
    const url = `${COMPANIES_BASE_URL}?order=name_lower.asc,name.asc&limit=${limit}&offset=${offset}`;
    
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: "count=exact" // Get total count in response headers
      }
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Fetch companies failed: ${res.status} ${res.statusText} - ${txt}`);
    }

    const data = await res.json();
    
    if (!Array.isArray(data)) {
      throw new Error("Unexpected companies response: " + JSON.stringify(data));
    }

    // Add companies from this page
    const companies = data.map((c) => ({
      id: c.id,
      name: c.name
    }));
    
    allCompanies.push(...companies);

    // If we got fewer results than the limit, we've reached the end
    if (data.length < limit) {
      break;
    }

    // Move to next page
    offset += limit;
    
    // Optional: Add a small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`Fetched ${allCompanies.length} total companies`);
  return allCompanies;
}

async function fetchDriversForCompany(token, company) {
  // Add small delay to avoid rate limiting
  await new Promise(resolve => setTimeout(resolve, 150));

  const url = `https://cloud.zeroeld.us/rest/logs_by_driver_view?select=id,first_name,last_name,username,assigned_vehicle_ids,last_seen&company_id=eq.${encodeURIComponent(company.id)}&order=last_seen.desc.nullslast&limit=1000`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!res.ok) {
      const txt = await res.text();
      console.warn(`Drivers fetch failed for ${company.id}: ${res.status} ${res.statusText} - ${txt}`);
      return {
        eldPlatform: "ZERO",
        companyId: company.id,
        name: company.name,
        drivers: [],
        error: txt
      };
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      return {
        eldPlatform: "ZERO",
        companyId: company.id,
        name: company.name,
        drivers: []
      };
    }

    // Filter out drivers with null last_seen or older than 15 days
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

    const totalDrivers = data.length;
    const drivers = data
      .filter((d) => {
        if (d.last_seen == null) return false;
        const lastSeenDate = new Date(d.last_seen);
        return lastSeenDate >= fifteenDaysAgo;
      })
      .map((d) => ({
        eldId: d.id,
        firstName: d.first_name,
        lastName: d.last_name,
        vehicle: d.assigned_vehicle_ids[0] || null,
      }));

    const filtered = totalDrivers - drivers.length;
    if (filtered > 0) {
      console.log(`Company ${company.id}: Filtered out ${filtered} of ${totalDrivers} drivers (older than 15 days or null last_seen)`);
    }

    return {
      eldPlatform: "ZERO",
      companyId: company.id,
      name: company.name,
      drivers
    };
  } catch (err) {
    console.warn(`Drivers fetch error for ${company.id}: ${String(err)}`);
    return {
      eldPlatform: "ZERO",
      companyId: company.id,
      name: company.name,
      drivers: [],
      error: String(err)
    };
  }
}

async function uploadToSupabaseStorage(filename, content) {
  const url = Deno.env.get("URL");
  const key = Deno.env.get("SERVICE_ROLE_KEY");
  
  if (!url || !key) {
    return {
      uploaded: false,
      reason: "missing supabase env"
    };
  }

  const supabase = createClient(url, key, {
    global: {
      fetch
    }
  });

  const bucket = "arc";
  const blob = new Blob([content], {
    type: "application/json"
  });

  try {
    const { error } = await supabase.storage
      .from(bucket)
      .upload(filename, blob, {
        upsert: true
      });

    if (error) {
      return {
        uploaded: false,
        reason: error.message
      };
    }

    return {
      uploaded: true
    };
  } catch (err) {
    return {
      uploaded: false,
      reason: String(err)
    };
  }
}

Deno.serve(async (req) => {
  const TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes (less than orchestrator's 30min timeout)

  try {
    // Create timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Zero function timeout after 25 minutes")), TIMEOUT_MS);
    });

    // Wrap all processing in a promise to race against timeout
    const processingPromise = (async () => {
      const token = await login();

      // Fetch ALL companies with pagination
      const companies = await fetchAllCompanies(token);

      const filteredCompanies = companies.filter((c) =>
        !c.name.toLowerCase().startsWith("zzz")
      );

      console.log(`Processing ${filteredCompanies.length} companies after filtering`);

      // Process companies in batches of 10 to avoid rate limiting
      const batchSize = 10;
      const allResults = [];

      for (let i = 0; i < filteredCompanies.length; i += batchSize) {
        const batch = filteredCompanies.slice(i, i + batchSize);
        console.log(`Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(filteredCompanies.length / batchSize)} (${batch.length} companies)`);

        const batchResults = await Promise.all(
          batch.map((c) => fetchDriversForCompany(token, c))
        );

        allResults.push(...batchResults);
      }

      return allResults;
    })();

    // Race processing against timeout
    const companyDrivers = await Promise.race([processingPromise, timeoutPromise]);

    // Convert now into Bishkek time
    function toBishkekISOString(date = new Date()) {
      const offsetMinutes = 6 * 60;
      const utc = date.getTime() + date.getTimezoneOffset() * 60000;
      const bishkek = new Date(utc + offsetMinutes * 60000);
      
      const pad = (n) => String(n).padStart(2, "0");
      const yyyy = bishkek.getFullYear();
      const mm = pad(bishkek.getMonth() + 1);
      const dd = pad(bishkek.getDate());
      const hh = pad(bishkek.getHours());
      const min = pad(bishkek.getMinutes());
      const ss = pad(bishkek.getSeconds());
      
      return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}+06:00`;
    }

    const result = {
      timestamp: toBishkekISOString(),
      totalCompanies: companyDrivers.length,
      companyDrivers
    };

    const resultJson = JSON.stringify(result, null, 2);

    // Try to upload to Supabase Storage 'arc'
    const upload = await uploadToSupabaseStorage("zero.json", resultJson);

    return new Response(resultJson, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-supabase-uploaded": String(upload.uploaded || false),
        "x-upload-reason": upload.uploaded ? "ok" : upload.reason || "no-credentials"
      }
    });
  } catch (err) {
    const body = {
      error: true,
      message: String(err)
    };
    return new Response(JSON.stringify(body, null, 2), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});