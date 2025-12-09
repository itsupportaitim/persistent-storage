// services/auth.ts

export function getBasicAuthHeader(username: string, password: string): string {
  const credentials = `${username}:${password}`;
  const encoded = btoa(credentials); // Deno/Web API for base64 encoding
  return `Basic ${encoded}`;
}

export async function getAuthToken(username: string, password: string): Promise<string> {
  if (!username || !password) {
    throw new Error("Missing credentials");
  }

  const res = await fetch("https://backend.apexhos.com/authentication", {
    method: "POST",
    headers: {
      Authorization: getBasicAuthHeader(username, password),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      company: null,
      email: username,
      password,
      rCode: "hero",
      strategy: "local",
    }),
  });

  if (!res.ok) {
    throw new Error(`Authentication failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.accessToken as string;
}
