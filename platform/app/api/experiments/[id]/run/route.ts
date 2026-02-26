import { NextResponse } from "next/server";
import { runExperiment } from "@/lib/runner";
import { getCurrentUser } from "@/lib/supabase-auth";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const { id: idParam } = await params;
    const id = Number(idParam.trim());
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    }
    const result = await runExperiment(id, user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "run failed" },
      { status: 500 }
    );
  }
}
