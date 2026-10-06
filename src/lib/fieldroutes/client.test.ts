import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FieldRoutesClient, fieldRoutesOfficeIdsFromEnv } from "./client.ts";

// Captures what the client sends to FieldRoutes, answering like FieldRoutes would.
function capture() {
  const sent: Array<{ url: string; form: URLSearchParams }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, form: new URLSearchParams(String(init.body)) });
    const body = String(url).endsWith("/search")
      ? { success: true, propertyName: "subscriptionIDs", idName: "subscriptionID", subscriptionIDs: [1, 2], ignoredParams: [] }
      : { success: true, subscriptions: [{ subscriptionID: 1 }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return sent;
}
const cfg = (officeIds?: number[]) => ({ baseUrl: "https://flexpc.fieldroutes.com/api", authKey: "k", authToken: "t", timeoutMs: 5000, officeIds });

describe("FR_OFFICE_IDS", () => {
  it("defaults to the NWA office (1) when unset", () => {
    assert.deepEqual(fieldRoutesOfficeIdsFromEnv(undefined), [1]);
    assert.deepEqual(fieldRoutesOfficeIdsFromEnv(""), [1]);
  });
  it("accepts a list, de-duplicated, and 'all' to switch the filter off", () => {
    assert.deepEqual(fieldRoutesOfficeIdsFromEnv("1, 2,2"), [1, 2]);
    assert.deepEqual(fieldRoutesOfficeIdsFromEnv("ALL"), []);
  });
  it("refuses garbage rather than silently syncing every office", () => {
    for (const bad of ["nwa", "1,x", "0", "-1", "1.5"]) assert.throws(() => fieldRoutesOfficeIdsFromEnv(bad), /FR_OFFICE_IDS/, bad);
  });
});

describe("office scoping on FieldRoutes reads", () => {
  it("every search sends officeIDs; get calls (IDs from those searches) do not need it", async () => {
    const sent = capture();
    const c = new FieldRoutesClient(cfg([1]));
    await c.searchIds("subscription", { active: 1 });
    await c.getEntities("subscription", ["1"]);
    assert.equal(sent[0].url, "https://flexpc.fieldroutes.com/api/subscription/search");
    assert.equal(sent[0].form.get("officeIDs"), "[1]");
    assert.equal(sent[0].form.get("active"), "1");
    // Auth stays LAST, per the FieldRoutes contract.
    assert.deepEqual([...sent[0].form.keys()].slice(-2), ["authenticationKey", "authenticationToken"]);
    assert.equal(sent[1].url.endsWith("/subscription/get"), true);
    assert.equal(sent[1].form.get("officeIDs"), null);
  });

  it("leaves an explicit office alone, and sends no filter when configured for all offices", async () => {
    const sent = capture();
    await new FieldRoutesClient(cfg([1])).searchIds("subscription", { officeIDs: [2] });
    await new FieldRoutesClient(cfg([])).searchIds("subscription", {});
    assert.equal(sent[0].form.get("officeIDs"), "[2]");
    assert.equal(sent[1].form.get("officeIDs"), null);
  });
});
