// @ts-nocheck
// services/filter_inactive_drivers.ts

export async function filterInactiveDrivers(inputFile: string, outputFile: string) {
  try {
    const raw = await Deno.readTextFile(inputFile);
    const companies = JSON.parse(raw);
    const filtered = companies.map(c => ({
      ...c,
      drivers: c.drivers.filter(d => d.active === true)
    }));
    await Deno.writeTextFile(outputFile, JSON.stringify(filtered, null, 2));
    return filtered;
  } catch (err) {
    console.error("filterInactiveDrivers error:", err);
    return []; // <- always return an array
  }
}

