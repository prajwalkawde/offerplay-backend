import { Response } from 'express';

export function success(
  res: Response,
  data: unknown = null,
  message = 'Success',
  statusCode = 200
): Response {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

export function error(
  res: Response,
  message = 'Internal Server Error',
  statusCode = 500,
  errors?: unknown
): Response {
  return res.status(statusCode).json({
    success: false,
    message,
    ...(errors !== undefined && { errors }),
  });
}

export function paginated(
  res: Response,
  data: unknown[],
  total: number,
  page: number,
  limit: number,
  message = 'Success'
): Response {
  return res.status(200).json({
    success: true,
    message,
    data,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    },
  });
}
