const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "The request could not be completed.");
  return body;
}

export const api = {
  listSessions: (query = "") => request(`/api/sessions${query}`),
  getSession: (id) => request(`/api/sessions/${id}`),
  createSession: (payload) => request("/api/sessions", { method: "POST", body: JSON.stringify(payload) }),
  startSession: (id) => request(`/api/sessions/${id}/start`, { method: "POST" }),
  stopSession: (id) => request(`/api/sessions/${id}/stop`, { method: "POST" }),
  completeSession: (id) => request(`/api/sessions/${id}/complete`, { method: "POST" }),
  deleteSession: (id) => request(`/api/sessions/${id}`, { method: "DELETE" }),
  processSession: (id) => request(`/api/sessions/${id}/process`, { method: "POST" }),
  regenerateSummary: (id) => request(`/api/sessions/${id}/regenerate-summary`, { method: "POST" }),
  verifySession: (id) => request(`/api/sessions/${id}/verify`, { method: "POST" }),
  getVerification: (id) => request(`/api/sessions/${id}/verification`),
};
