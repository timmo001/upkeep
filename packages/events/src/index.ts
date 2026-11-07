/**
 * The events Worker, at the GitHub App's webhook URL: it checks each
 * delivery's signature, queues what Upkeep reads for the server to pull, and
 * answers well inside GitHub's 10 seconds. Nothing on the server is opened to
 * the internet, and a delivery waits in the queue while the server restarts.
 */
import { slim, verify } from "./delivery";

/** The queue binding, sending text so the server's HTTP pull reads it as is. */
interface EventsQueue {
  send(body: string, options: { contentType: "text" }): Promise<void>;
}

export interface Env {
  readonly EVENTS: EventsQueue;
  /** The GitHub App's webhook secret, set with `wrangler secret put`. */
  readonly WEBHOOK_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Upkeep's GitHub webhook takes POST requests\n", {
        status: 405,
        headers: { allow: "POST" },
      });

    const body = await request.text();

    if (
      !(await verify(
        env.WEBHOOK_SECRET,
        body,
        request.headers.get("x-hub-signature-256"),
      ))
    )
      return new Response("Bad signature\n", { status: 401 });

    const event = request.headers.get("x-github-event") ?? "";

    if (event === "ping") return new Response(null, { status: 204 });

    const message = slim(
      event,
      request.headers.get("x-github-delivery") ?? "",
      body,
      Date.now(),
    );

    if (message === null)
      return new Response(`Not taken: ${event}\n`, { status: 202 });

    await env.EVENTS.send(JSON.stringify(message), { contentType: "text" });

    return new Response(null, { status: 202 });
  },
};
