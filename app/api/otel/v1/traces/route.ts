import { NextResponse } from "next/server";
import { ingestTracePayload } from "@/lib/otel";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const inserted = await ingestTracePayload(payload);
    return NextResponse.json({ ok: true, inserted });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "invalid payload" },
      { status: 400 }
    );
  }
}
