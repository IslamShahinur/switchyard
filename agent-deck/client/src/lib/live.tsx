import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Snapshot } from "@shared/schema";
import { API_BASE, apiRequest } from "./queryClient";

type Transport = "sse" | "poll" | "offline";
interface LiveCtx {
  snap: Snapshot | null;
  transport: Transport;
  refresh: () => Promise<void>;
  act: <T = unknown>(method: string, url: string, body?: unknown) => Promise<T>;
}

const Ctx = createContext<LiveCtx>(null as any);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [transport, setTransport] = useState<Transport>("offline");
  const pollRef = useRef<number>();

  const refresh = useCallback(async () => {
    try {
      const r = await apiRequest("GET", "/api/snapshot");
      setSnap(await r.json());
    } catch {
      setTransport("offline");
    }
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let gotMsg = false;
    const startPolling = () => {
      setTransport("poll");
      window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(refresh, 1500);
    };
    try {
      es = new EventSource(`${API_BASE}/api/stream`);
      es.onmessage = (e) => {
        gotMsg = true;
        setTransport("sse");
        window.clearInterval(pollRef.current);
        setSnap(JSON.parse(e.data));
      };
      es.onerror = () => {
        es?.close();
        startPolling();
      };
    } catch {
      startPolling();
    }
    refresh();
    // if the proxy buffers SSE, fall back to polling
    const t = window.setTimeout(() => {
      if (!gotMsg) {
        es?.close();
        startPolling();
      }
    }, 4000);
    return () => {
      es?.close();
      window.clearTimeout(t);
      window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  const act = useCallback(
    async <T,>(method: string, url: string, body?: unknown) => {
      const r = await apiRequest(method, url, body);
      const txt = await r.text();
      if (transport !== "sse") refresh();
      return (txt ? JSON.parse(txt) : undefined) as T;
    },
    [refresh, transport],
  );

  const value = useMemo(() => ({ snap, transport, refresh, act }), [snap, transport, refresh, act]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);

/* ------------------------------ helpers ----------------------------- */

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function ago(ts?: number, now = Date.now()) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function until(ts?: number, now = Date.now()) {
  if (!ts) return "—";
  const s = Math.round((ts - now) / 1000);
  if (s <= 0) return "due";
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h ${m % 60}m`;
  return `in ${Math.round(h / 24)}d`;
}

export function clock(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTime(ts?: number) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** best-effort human readable cron */
export function describeCron(expr: string) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return "invalid";
  const [mi, h, dom, mon, dow] = f;
  const days: Record<string, string> = { "*": "every day", "1-5": "weekdays", "0,6": "weekends", "6,0": "weekends", "0": "Sundays", "1": "Mondays", "5": "Fridays" };
  if (mi.startsWith("*/") && h === "*") return `every ${mi.slice(2)} min`;
  if (/^\d+$/.test(mi) && h === "*") return `hourly at :${mi.padStart(2, "0")}`;
  if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === "*" && mon === "*") return `${days[dow] ?? `dow ${dow}`} at ${h.padStart(2, "0")}:${mi.padStart(2, "0")}`;
  return expr;
}
