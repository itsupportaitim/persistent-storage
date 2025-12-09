import { DateTime } from "https://esm.sh/luxon@3.4.4";

// removeDriverFields.ts
export async function removeDriverFields(inputPath: string, outputPath: string) {
  // Read file
  const raw = await Deno.readTextFile(inputPath);
  const companies = JSON.parse(raw) as Array<{ drivers: any[]; [key: string]: any }>;

  // Remove fields from drivers
  const cleaned = companies.map(company => ({
    ...company,
    drivers: company.drivers.map(({ active, updatedAt, ...rest }) => rest),
  }));
  const result = { timestamp: DateTime.now().setZone("Asia/Bishkek").toISO(), companyDrivers: cleaned }
  // Write new JSON file
  await Deno.writeTextFile(outputPath, JSON.stringify(result, null, 2));
}
