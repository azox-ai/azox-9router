import { NextResponse } from "next/server";
import {
  createProviderConnection,
  deleteProviderConnection,
  getProviderConnections,
  updateProviderConnection,
} from "@/models";
import { hasValidPortalSyncToken } from "@/lib/auth/portalSync";

const ALLOWED_PROVIDERS = new Set(["claude", "codex"]);
const MAX_EXTERNAL_ID_LENGTH = 128;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function findManagedConnection(externalId) {
  const connections = await getProviderConnections();
  return connections.find((connection) =>
    connection.providerSpecificData?.portalExternalId === externalId
  ) || null;
}

function parseVersion(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function normalizeBody(body) {
  const tokenVersion = parseVersion(body?.tokenVersion);
  const expiresAt = new Date(body?.expiresAt || "");
  if (!ALLOWED_PROVIDERS.has(body?.provider)) throw new Error("Unsupported provider");
  if (typeof body?.accessToken !== "string" || body.accessToken.length === 0) throw new Error("accessToken is required");
  if (!Number.isFinite(expiresAt.getTime())) throw new Error("expiresAt is invalid");
  if (tokenVersion === null) throw new Error("tokenVersion must be a positive integer");

  const providerSpecificData = body.providerSpecificData && typeof body.providerSpecificData === "object"
    ? { ...body.providerSpecificData }
    : {};
  delete providerSpecificData.portalExternalId;
  delete providerSpecificData.portalTokenVersion;

  return {
    provider: body.provider,
    accessToken: body.accessToken,
    expiresAt: expiresAt.toISOString(),
    tokenVersion,
    email: typeof body.email === "string" ? body.email : undefined,
    name: typeof body.name === "string" ? body.name : undefined,
    idToken: typeof body.idToken === "string" ? body.idToken : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    tokenType: typeof body.tokenType === "string" ? body.tokenType : undefined,
    enabled: body.enabled !== false,
    providerSpecificData,
  };
}

export async function PUT(request, { params }) {
  if (!hasValidPortalSyncToken(request)) return unauthorized();
  const { externalId } = await params;
  if (!externalId || externalId.length > MAX_EXTERNAL_ID_LENGTH) {
    return NextResponse.json({ error: "externalId is invalid" }, { status: 400 });
  }

  let input;
  try {
    input = normalizeBody(await request.json());
  } catch (error) {
    return NextResponse.json({ error: error.message || "Invalid request" }, { status: 400 });
  }

  const existing = await findManagedConnection(externalId);
  const currentVersion = existing?.providerSpecificData?.portalTokenVersion || 0;
  if (existing && input.tokenVersion < currentVersion) {
    return NextResponse.json({ error: "Stale tokenVersion", tokenVersion: currentVersion }, { status: 409 });
  }
  if (existing && existing.provider !== input.provider) {
    return NextResponse.json({ error: "Provider cannot be changed" }, { status: 409 });
  }
  if (existing && input.tokenVersion === currentVersion) {
    return NextResponse.json({
      id: existing.id,
      provider: existing.provider,
      enabled: existing.isActive !== false,
      expiresAt: existing.expiresAt || null,
      tokenVersion: currentVersion,
    });
  }

  const providerSpecificData = {
    ...(existing?.providerSpecificData || {}),
    ...input.providerSpecificData,
    portalExternalId: externalId,
    portalTokenVersion: input.tokenVersion,
  };
  const values = {
    provider: input.provider,
    authType: "oauth",
    accessToken: input.accessToken,
    expiresAt: input.expiresAt,
    lastRefreshAt: new Date().toISOString(),
    testStatus: "active",
    isActive: input.enabled,
    providerSpecificData,
    ...(input.email ? { email: input.email } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.idToken ? { idToken: input.idToken } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.tokenType ? { tokenType: input.tokenType } : {}),
  };

  // On update the key must be present and undefined: the repository merges the
  // incoming object over the stored one and serializes it to JSON, so an
  // explicit undefined is what actually drops a refresh token this router must
  // never own. On create the key is omitted entirely.
  const connection = existing
    ? await updateProviderConnection(existing.id, { ...values, refreshToken: undefined })
    : await createProviderConnection(values);

  return NextResponse.json({
    id: connection.id,
    provider: connection.provider,
    enabled: connection.isActive !== false,
    expiresAt: input.expiresAt,
    tokenVersion: input.tokenVersion,
  });
}

export async function GET(request, { params }) {
  if (!hasValidPortalSyncToken(request)) return unauthorized();
  const { externalId } = await params;
  const connection = await findManagedConnection(externalId);
  if (!connection) return NextResponse.json({ found: false }, { status: 404 });
  return NextResponse.json({
    found: true,
    id: connection.id,
    provider: connection.provider,
    enabled: connection.isActive !== false,
    expiresAt: connection.expiresAt || null,
    tokenVersion: connection.providerSpecificData?.portalTokenVersion || 0,
  });
}

export async function DELETE(request, { params }) {
  if (!hasValidPortalSyncToken(request)) return unauthorized();
  const { externalId } = await params;
  const connection = await findManagedConnection(externalId);
  if (!connection) return NextResponse.json({ found: false }, { status: 404 });
  await deleteProviderConnection(connection.id);
  return new Response(null, { status: 204 });
}
