import pino from "pino";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: null,
  ...(process.stdout.isTTY
    ? {
        transport: {
          target: "pino-pretty",
          options: { translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
        },
      }
    : {}),
});
