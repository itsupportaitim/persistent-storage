// @ts-nocheck


// services/file.ts

export async function writeJSON(filePath: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  await Deno.writeTextFile(filePath, text);
}
