// services/companies.ts

export async function getCompanies(token: string): Promise<any> {
  const res = await fetch("https://backend.apexhos.com/companies", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch companies: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data;
}

// Фильтрация до companyId и name + удаление компаний, имя которых начинается с "zzz"
export function filterCompanies(raw: any): { companyId: string; name: string }[] {
  if (!raw?.data || !Array.isArray(raw.data)) {
    throw new Error("Invalid companies structure");
  }

  return raw.data
    .map((c: any) => ({ companyId: c.companyId, name: c.name }))
    .filter((c: { companyId: string; name: string }) => !c.name.toLowerCase().startsWith("zzz"));
}
