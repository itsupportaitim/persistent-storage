// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only handle POST requests
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { eldId } = await req.json();

    if (!eldId) {
      return new Response(JSON.stringify({ error: "eldId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      return new Response(JSON.stringify({ error: "Missing Supabase credentials" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Determine which file to search based on eldId prefix
    const isHero = eldId.startsWith("User:");
    const fileName = isHero ? "hero.json" : "zero.json";

    const { data: fileData, error: fileError } = await supabase.storage.from("arc").download(fileName);

    if (fileError || !fileData) {
      return new Response(JSON.stringify({ error: `Failed to fetch ${fileName}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let foundDriver = null;
    let foundCompany = null;

    const fileText = await fileData.text();
    const jsonData = JSON.parse(fileText);
    const companies = jsonData.companyDrivers || jsonData;

    for (const company of companies) {
      const driver = company.drivers?.find((d) => d.eldId === eldId);
      if (driver) {
        foundDriver = driver;
        foundCompany = company;
        break;
      }
    }

    // Remove from blacklist regardless of whether driver is found
    await supabase.from("driver_blacklist").delete().eq("driver_eld_id", eldId);

    if (!foundDriver || !foundCompany) {
      return new Response(JSON.stringify({
        success: true,
        message: "Driver not found in files, but removed from blacklist if existed",
        eldId
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get date from existing record for this driver in the same company
    const companyEldId = foundCompany.companyId || foundCompany.id;
    const { data: existingRecord } = await supabase
      .from("daily_master_eld_data")
      .select("date_of_data")
      .eq("company_eld_id", companyEldId)
      .limit(1)
      .single();

    if (!existingRecord?.date_of_data) {
      return new Response(JSON.stringify({ error: "No existing record found for this company to get date", company_eld_id: companyEldId }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const dateOfData = existingRecord.date_of_data;
    const driverName = `${foundDriver.firstName || ""} ${foundDriver.lastName || ""}`.trim();

    // Upsert into daily_master_eld_data (overwrite if exists)
    const { error: masterError } = await supabase.from("daily_master_eld_data").upsert({
      company_eld_id: foundCompany.companyId || foundCompany.id,
      company_name: foundCompany.name,
      driver_eld_id: eldId,
      driver_name: driverName,
      date_of_data: dateOfData,
      vehicle_id: foundDriver.vehicle,
      vehicleinfo: null,
    }, { onConflict: "company_eld_id,driver_eld_id" });

    if (masterError) {
      return new Response(JSON.stringify({ error: "Failed to upsert into daily_master_eld_data", details: masterError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get user_id from existing allocation for this company
    const { data: existingAlloc } = await supabase
      .from("daily_allocations")
      .select("user_id")
      .eq("company_eld_id", companyEldId)
      .limit(1)
      .single();

    if (!existingAlloc?.user_id) {
      return new Response(JSON.stringify({ error: "No existing allocation found for this company", company_eld_id: companyEldId }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Insert into daily_allocations
    const { error: allocError } = await supabase.from("daily_allocations").insert({
      user_id: existingAlloc.user_id,
      company_eld_id: companyEldId,
      driver_eld_id: eldId,
      allocation_date: dateOfData,
      vehicle_id: foundDriver.vehicle,
    });

    if (allocError) {
      return new Response(JSON.stringify({ error: "Failed to insert into daily_allocations", details: allocError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
