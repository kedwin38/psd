import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { GlobalFonts } from "@napi-rs/canvas";
import { WorkerModule } from "./worker.module";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  // eslint-disable-next-line no-console
  console.log("PSD Template Studio ingestion/render worker started.");
  if (GlobalFonts.families.length === 0) {
    // eslint-disable-next-line no-console
    console.warn("No system fonts found: exports and previews will render without any text. Install a font package (see apps/api/Dockerfile).");
  }

  // Deployment platforms (DigitalOcean App Platform, Kubernetes, …) run TCP/HTTP readiness
  // probes against every port a container exposes — but a pure queue worker never listens
  // anywhere, so such a probe can only ever fail and roll the deployment back. When a probe
  // port is configured, answer it with a trivial always-200 endpoint: it says exactly what is
  // true (the worker process is up and its event loop is serving) without pretending to be
  // anything else. The real work happens on the queues.
  const probePort = Number(process.env.WORKER_HEALTH_PORT ?? 0);
  if (probePort > 0) {
    const http = await import("node:http");
    http
      .createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("worker up\n");
      })
      .listen(probePort, () => {
        // eslint-disable-next-line no-console
        console.log(`Worker health endpoint listening on :${probePort} (process liveness only).`);
      });
  }
}

bootstrap();
