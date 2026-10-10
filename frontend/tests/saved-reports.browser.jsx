// Browser-only TEST harness: mocked API responses are never runtime REAL assets.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { IncidentProvider } from "../src/context/IncidentContext";
import { Route as analysisRoute } from "../src/routes/analysis";

export async function verifySwitching({ demo, real, noSpill, inconclusive }) {
  const reports = new Map([
    [demo.id, demo],
    [real.id, real],
  ]);
  const requests = [];
  let networkFailure = false;
  window.fetch = async (input, options) => {
    const url = new URL(String(input), window.location.href);
    requests.push(url.pathname);
    let data;
    if (url.pathname === "/api/incidents/scenes") {
      data = [
        { id: "demo-arabian-sea", name: "TEST DEMO", mode: "DEMO" },
        { id: real.scene.id, name: "TEST archived scene", mode: "REAL" },
      ];
    } else if (url.pathname === "/api/incidents/analyze" && options?.method === "POST") {
      if (networkFailure) throw new TypeError("TEST network disconnected");
      const requested = JSON.parse(options.body);
      data =
        requested.sceneId === "demo-no-spill"
          ? noSpill
          : requested.sceneId === "demo-inconclusive"
            ? inconclusive
            : { ...demo, id: "test-new-demo" };
      reports.set(data.id, data);
    } else if (url.pathname === "/api/incidents") {
      data = [...reports.values()];
    } else if (url.pathname.startsWith("/api/incidents/")) {
      data = reports.get(url.pathname.split("/").at(-1));
    } else if (url.pathname.startsWith("/api/spills")) {
      data = []; // Legacy context must not supply the computed report.
    } else {
      throw new Error(`Unexpected request: ${url.pathname}`);
    }
    return new Response(JSON.stringify(data), {
      status: data ? 200 : 404,
      headers: { "Content-Type": "application/json" },
    });
  };

  const rootRoute = createRootRoute({
    component: () => (
      <IncidentProvider>
        <Outlet />
      </IncidentProvider>
    ),
  });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: analysisRoute.options.component,
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([route]) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  createRoot(document.getElementById("root")).render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const wait = async (predicate, message) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(message);
  };
  const saved = () =>
    [...document.querySelectorAll("label")]
      .find((label) => label.textContent.includes("Saved reports"))
      ?.querySelector("select");
  const scene = () => document.querySelector('select[aria-label="Scene"]');
  const select = (element, value) => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const text = () => document.body.textContent;
  const image = () => document.querySelector("svg image");
  const button = (label) =>
    [...document.querySelectorAll("button")].find(
      (element) => element.textContent.trim() === label,
    );

  await wait(() => saved()?.options.length === 3, "Saved reports failed to load");
  select(saved(), demo.id);
  await wait(() => image() && text().includes(demo.candidates[0].name), "DEMO evidence missing");
  const demoImage = image().getAttribute("href");
  select(scene(), real.scene.id);
  await wait(() => button("Analyze REAL pipeline"), "REAL scene selection failed");
  check(saved().value === demo.id && image(), "Next scene changed saved report");
  [...document.querySelectorAll("label")]
    .find((label) => label.textContent.trim() === "SAR")
    .querySelector('input[type="checkbox"]')
    .click();
  await wait(() => !image(), "Layer control failed");

  select(saved(), real.id);
  await wait(() => text().includes("Modeled origin unavailable"), "REAL report failed to load");
  check(!image(), "DEMO raster leaked into unavailable REAL report");
  check(!text().includes(demo.candidates[0].name), "DEMO vessel leaked into REAL report");
  check(text().includes("Spill age unavailable"), "REAL age mislabeled");

  select(saved(), demo.id);
  await wait(() => image() && text().includes(demo.candidates[0].name), "Returning to DEMO failed");
  check(image().getAttribute("href") === demoImage, "DEMO raster or layer state did not reset");
  check(!text().includes("Modeled origin unavailable"), "Stale REAL state retained");
  check(scene().value === real.scene.id, "Saved selection changed next scene");

  select(scene(), "demo-arabian-sea");
  await wait(() => button("Analyze DEMO pipeline"), "DEMO scene selection failed");
  button("Analyze DEMO pipeline").click();
  await wait(() => saved().value === "test-new-demo", "New analysis was not selected");
  select(saved(), real.id);
  await wait(
    () => text().includes("Modeled origin unavailable"),
    "Mutation result blocked saved selection",
  );
  check(!image() && !text().includes(demo.candidates[0].name), "Stale mutation evidence leaked");
  select(saved(), "");
  await wait(() => !document.querySelector("h2"), "Clearing selection retained report");
  check(requests.includes(`/api/incidents/${real.id}`), "REAL report was not fetched");
  check(requests.includes(`/api/incidents/${demo.id}`), "DEMO report was not fetched");
  select(scene(), "demo-no-spill");
  await wait(() => scene().value === "demo-no-spill", "No-spill selection failed");
  button("Analyze DEMO pipeline").click();
  await wait(() => text().includes("NO_SPILL_DETECTED"), "No-spill dashboard missing");
  check(
    document.querySelector('[aria-label="Analyzed scene footprint"]'),
    "No-spill footprint missing",
  );
  check(!text().includes(demo.candidates[0].name), "Vessels leaked into clear scene");
  select(scene(), "demo-inconclusive");
  await new Promise((resolve) => setTimeout(resolve, 30));
  button("Analyze DEMO pipeline").click();
  await wait(() => text().includes("Zero valid SAR coverage"), "Inconclusive diagnostics missing");
  networkFailure = true;
  button("Analyze DEMO pipeline").click();
  await wait(() => text().includes("NETWORK ERROR"), "Network recovery UI missing");
  check(button("Retry loading data"), "Retry action missing");
  // UPLOAD mode is intentionally not exposed in the primary judge-facing dropdown.
  // The underlying SARUpload component and backend upload route remain available
  // for testing via the internal upload endpoint and regression tests.
}
