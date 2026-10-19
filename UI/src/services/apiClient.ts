export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/+$/, "");

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

interface ApiErrorBody {
  detail?: string;
  message?: string;
  error?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const data = (await response.json().catch(() => ({}))) as ApiErrorBody;

  if (response.status === 401 && !path.startsWith("/auth/")) {
    window.dispatchEvent(new Event("rb-auth-expired"));
  }

  if (!response.ok) {
    throw new ApiError(
      data.detail || data.message || data.error || "The request failed. Please try again.",
      response.status,
    );
  }

  return data as T;
}
