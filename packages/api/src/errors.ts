/** HTTP-safe domain failure whose message may be returned to an API caller. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = () => new ApiError(401, "unauthorized", "Unauthorized");
export const forbidden = () => new ApiError(403, "forbidden", "Forbidden");
export const notFound = (resource: string) =>
  new ApiError(404, "not_found", `${resource} not found`);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
