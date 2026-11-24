import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { Api } from "@standard-artifacts/protocol"

/**
 * Typed client for the shared HttpApi contract. In dev, `devAs` switches the
 * caller (guest/viewer/agent) via a header the Worker honors only when
 * AUTH_MODE=dev.
 */
export const api = (devAs: string) =>
  HttpApiClient.make(Api, {
    baseUrl: window.location.origin,
    transformClient:
      import.meta.env.DEV && devAs !== "owner"
        ? HttpClient.mapRequest(HttpClientRequest.setHeader("x-dev-as", devAs))
        : undefined,
  }).pipe(Effect.provide(FetchHttpClient.layer))

/** Typed API errors carry a message; anything else (network, decode) gets a generic one. */
export const errorMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string" ? e.message : "Request failed"
