// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  // Only handle POST requests
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { eldId } = await req.json();

    if (!eldId) {
      return new Response(JSON.stringify({ error: "eldId is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      return new Response(JSON.stringify({ error: "Missing Supabase credentials" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch hero.json and zero.json from storage
    const [heroRes, zeroRes] = await Promise.all([
      supabase.storage.from("arc").download("hero.json"),
      supabase.storage.from("arc").download("zero.json"),
    ]);

    if (heroRes.error && zeroRes.error) {
      return new Response(JSON.stringify({ error: "Failed to fetch driver data files" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    let foundDriver = null;
    let foundCompany = null;

    // Search in hero.json
    if (heroRes.data) {
      const heroText = await heroRes.data.text();
      const heroData = JSON.parse(heroText);
      const companies = heroData.companyDrivers || heroData;

      for (const company of companies) {
        const driver = company.drivers?.find((d) => d.eldId === eldId);
        if (driver) {
          foundDriver = driver;
          foundCompany = company;
          break;
        }
      }
    }

    // If not found in hero, search in zero.json
    if (!foundDriver && zeroRes.data) {
      const zeroText = await zeroRes.data.text();
      const zeroData = JSON.parse(zeroText);
      const companies = zeroData.companyDrivers || zeroData;

      for (const company of companies) {
        const driver = company.drivers?.find((d) => d.eldId === eldId);
        if (driver) {
          foundDriver = driver;
          foundCompany = company;
          break;
        }
      }
    }

    if (!foundDriver || !foundCompany) {
      return new Response(JSON.stringify({ error: "Driver not found", eldId }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Get today's date in Bishkek time (UTC+6)
    function getBishkekDate() {
      const now = new Date();
      const utc = now.getTime() + now.getTimezoneOffset() * 60000;
      const bishkek = new Date(utc + 6 * 60 * 60000);
      const yyyy = bishkek.getFullYear();
      const mm = String(bishkek.getMonth() + 1).padStart(2, "0");
      const dd = String(bishkek.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    }
    const today = getBishkekDate();
    const driverName = `${foundDriver.firstName || ""} ${foundDriver.lastName || ""}`.trim();

    // Upsert into daily_master_eld_data (overwrite if exists)
    const { error: masterError } = await supabase.from("daily_master_eld_data").upsert({
      company_eld_id: foundCompany.companyId || foundCompany.id,
      company_name: foundCompany.name,
      driver_eld_id: eldId,
      driver_name: driverName,
      date_of_data: today,
      vehicle_id: foundDriver.vehicle,
      vehicleinfo: null,
    }, { onConflict: "driver_eld_id" });

    if (masterError) {
      return new Response(JSON.stringify({ error: "Failed to upsert into daily_master_eld_data", details: masterError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Remove from blacklist if exists
    await supabase.from("driver_blacklist").delete().eq("driver_eld_id", eldId);

    // Get user_id from existing allocation for this company
    const companyEldId = foundCompany.companyId || foundCompany.id;
    const { data: existingAlloc } = await supabase
      .from("daily_allocations")
      .select("user_id")
      .eq("company_eld_id", companyEldId)
      .limit(1)
      .single();

    if (!existingAlloc?.user_id) {
      return new Response(JSON.stringify({ error: "No existing allocation found for this company", company_eld_id: companyEldId }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Insert into daily_allocations
    const { error: allocError } = await supabase.from("daily_allocations").insert({
      user_id: existingAlloc.user_id,
      company_eld_id: companyEldId,
      driver_eld_id: eldId,
      allocation_date: today,
      vehicle_id: foundDriver.vehicle,
    });

    if (allocError) {
      return new Response(JSON.stringify({ error: "Failed to insert into daily_allocations", details: allocError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      driver: {
        eldId,
        name: driverName,
        company: foundCompany.name,
        vehicle: foundDriver.vehicle,
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
