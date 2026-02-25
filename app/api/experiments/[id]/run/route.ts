import { NextResponse } from "next/server";
import { runExperiment } from "@/lib/runner";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await runExperiment(id);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "run failed" },
      { status: 500 }
    );
  }
}
