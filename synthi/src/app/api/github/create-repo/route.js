import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";

export async function POST(req) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.accessToken) {
      return NextResponse.json(
        { error: "Not authenticated. Please sign in with GitHub." },
        { status: 401 },
      );
    }

    const { name, description, isPrivate } = await req.json();

    if (!name || !name.trim()) {
      return NextResponse.json(
        { error: "Repository name is required." },
        { status: 400 },
      );
    }

    // Validate repo name (GitHub rules: alphanumeric, hyphens, underscores, dots)
    const repoNameRegex = /^[a-zA-Z0-9._-]+$/;
    if (!repoNameRegex.test(name.trim())) {
      return NextResponse.json(
        {
          error:
            "Repository name can only contain alphanumeric characters, hyphens, underscores, and dots.",
        },
        { status: 400 },
      );
    }

    const ghRes = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "User-Agent": "Synthi-IDE",
      },
      body: JSON.stringify({
        name: name.trim(),
        description: description?.trim() || "",
        private: !!isPrivate,
        auto_init: true, // Create with README so it's not empty
      }),
    });

    if (!ghRes.ok) {
      const errData = await ghRes.json().catch(() => ({}));
      let message =
        errData.errors?.[0]?.message ||
        errData.message ||
        "Failed to create repository on GitHub.";

      if (ghRes.status === 404 || ghRes.status === 403) {
        message = "GitHub rejected the request (404/403). Your token might lack the 'repo' scope. Please sign out and sign in again to re-authorize Synthi.";
      }

      console.error("[API] GitHub create-repo failed:", ghRes.status, errData);

      return NextResponse.json(
        { error: message },
        { status: ghRes.status === 404 ? 401 : ghRes.status }
      );
    }

    const repo = await ghRes.json();

    return NextResponse.json({
      cloneUrl: repo.clone_url,
      htmlUrl: repo.html_url,
      name: repo.name,
      fullName: repo.full_name,
      isPrivate: repo.private,
    });
  } catch (e) {
    console.error("[API] create-repo error:", e);
    return NextResponse.json(
      { error: "Internal server error while creating repository." },
      { status: 500 },
    );
  }
}
