import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
  getProxyPoolById,
  updateProviderConnection,
  deleteProviderConnection,
} from "@/models";
import { toProviderConnectionResponse, usesAwsCredentialForm } from "@/lib/providerConnectionResponse";
import { validateLocalBalancePatch } from "open-sse/services/usage/localBalance.js";
import { invalidateLocalBalanceCache } from "@/lib/localBalanceGuard.js";

function normalizeProxyConfig(body = {}) {
  const hasAnyProxyField =
    Object.prototype.hasOwnProperty.call(body, "connectionProxyEnabled") ||
    Object.prototype.hasOwnProperty.call(body, "connectionProxyUrl") ||
    Object.prototype.hasOwnProperty.call(body, "connectionNoProxy");

  if (!hasAnyProxyField) return { hasAnyProxyField: false };

  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return {
      hasAnyProxyField: true,
      error: "Connection proxy URL is required when connection proxy is enabled",
    };
  }

  return {
    hasAnyProxyField: true,
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolUpdate(proxyPoolIdInput) {
  if (proxyPoolIdInput === undefined) {
    return { hasProxyPoolField: false, proxyPoolId: null };
  }

  if (proxyPoolIdInput === null || proxyPoolIdInput === "" || proxyPoolIdInput === "__none__") {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPoolId = String(proxyPoolIdInput).trim();
  if (!proxyPoolId) {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(proxyPoolId);
  if (!proxyPool) {
    return { hasProxyPoolField: true, error: "Proxy pool not found" };
  }

  return { hasProxyPoolField: true, proxyPoolId };
}

function shouldMergeProviderSpecificData(existing, incoming, hasLegacyProxy, hasProxyPoolField) {
  return existing !== undefined || incoming !== undefined || hasLegacyProxy || hasProxyPoolField;
}

// GET /api/providers/[id] - Get single connection
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({ connection: toProviderConnectionResponse(connection) });
  } catch (error) {
    console.log("Error fetching connection:", error);
    return NextResponse.json({ error: "Failed to fetch connection" }, { status: 500 });
  }
}

// PUT /api/providers/[id] - Update connection
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const {
      name,
      priority,
      globalPriority,
      defaultModel,
      isActive,
      apiKey,
      testStatus,
      lastError,
      lastErrorAt,
      providerSpecificData,
      localBalanceAction,
    } = body;

    if (localBalanceAction !== undefined) {
      if (!localBalanceAction || typeof localBalanceAction !== "object" || Array.isArray(localBalanceAction)) {
        return NextResponse.json({ error: "Invalid localBalanceAction" }, { status: 400 });
      }
      const actionType = localBalanceAction.type;
      const amount = localBalanceAction.amount;
      const fxRate = localBalanceAction.fxRate;
      if (actionType !== "calibrate" && actionType !== "topup") {
        return NextResponse.json({ error: "Invalid localBalanceAction.type" }, { status: 400 });
      }
      if (
        typeof amount !== "number" ||
        !Number.isFinite(amount) ||
        amount > 1e9 ||
        (actionType === "calibrate" ? amount < 0 : amount <= 0)
      ) {
        return NextResponse.json({ error: "Invalid localBalanceAction.amount" }, { status: 400 });
      }
      if (
        fxRate !== undefined &&
        (typeof fxRate !== "number" || !Number.isFinite(fxRate) || fxRate <= 0 || fxRate >= 1000)
      ) {
        return NextResponse.json({ error: "Invalid localBalanceAction.fxRate" }, { status: 400 });
      }

      let actionError = null;
      const updatedAction = await updateProviderConnection(id, (existingConn) => {
        const existingLb = existingConn?.providerSpecificData?.localBalance;
        if (!existingLb || existingLb.enabled !== true) {
          actionError = "Local balance is not enabled for this connection";
          return null;
        }
        const candidate =
          actionType === "calibrate"
            ? {
                ...existingLb,
                initialAmount: amount,
                since: new Date().toISOString(),
                ...(fxRate !== undefined ? { fxRate } : {}),
              }
            : {
                ...existingLb,
                initialAmount: (Number(existingLb.initialAmount) || 0) + amount,
              };
        const check = validateLocalBalancePatch(candidate);
        if (!check.valid) {
          actionError = check.error;
          return null;
        }
        return {
          providerSpecificData: {
            ...(existingConn.providerSpecificData || {}),
            localBalance: check.value,
          },
        };
      });

      if (!updatedAction) {
        return NextResponse.json({ error: "Connection not found" }, { status: 404 });
      }
      if (actionError) {
        return NextResponse.json({ error: actionError }, { status: 400 });
      }
      invalidateLocalBalanceCache(id);
      return NextResponse.json({ connection: toProviderConnectionResponse(updatedAction) });
    }

    const existing = await getProviderConnectionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    const proxyPoolResult = await normalizeProxyPoolUpdate(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return NextResponse.json({ error: proxyPoolResult.error }, { status: 400 });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (priority !== undefined) updateData.priority = priority;
    if (globalPriority !== undefined) updateData.globalPriority = globalPriority;
    if (defaultModel !== undefined) updateData.defaultModel = defaultModel;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (apiKey && existing.authType === "apikey") updateData.apiKey = apiKey;
    if (testStatus !== undefined) updateData.testStatus = testStatus;
    if (lastError !== undefined) updateData.lastError = lastError;
    if (lastErrorAt !== undefined) updateData.lastErrorAt = lastErrorAt;

    if (
      shouldMergeProviderSpecificData(
        existing.providerSpecificData,
        providerSpecificData,
        proxyConfig.hasAnyProxyField,
        proxyPoolResult.hasProxyPoolField
      )
    ) {
      const incomingProviderSpecificData = { ...(providerSpecificData || {}) };
      const isAwsCredential = usesAwsCredentialForm(existing.provider);
      // The edit form cannot read the stored token back. An empty password field means
      // keep the saved credential; null explicitly removes it.
      if (isAwsCredential && incomingProviderSpecificData.sessionToken === "") {
        delete incomingProviderSpecificData.sessionToken;
      }
      updateData.providerSpecificData = {
        ...(existing.providerSpecificData || {}),
        ...incomingProviderSpecificData,
      };
      if (isAwsCredential && incomingProviderSpecificData.sessionToken === null) {
        delete updateData.providerSpecificData.sessionToken;
      }

      if (Object.prototype.hasOwnProperty.call(incomingProviderSpecificData, "localBalance")) {
        if (incomingProviderSpecificData.localBalance === null) {
          delete updateData.providerSpecificData.localBalance;
        } else {
          const rawLb = incomingProviderSpecificData.localBalance;
          const existingLb = existing.providerSpecificData?.localBalance;
          const candidate =
            rawLb &&
            typeof rawLb === "object" &&
            !Array.isArray(rawLb) &&
            rawLb.since === undefined &&
            existingLb?.enabled === true &&
            existingLb?.since
              ? { ...rawLb, since: existingLb.since }
              : rawLb;
          const check = validateLocalBalancePatch(candidate);
          if (!check.valid) {
            return NextResponse.json({ error: check.error }, { status: 400 });
          }
          updateData.providerSpecificData.localBalance = check.value;
        }
      }

      if (proxyConfig.hasAnyProxyField) {
        updateData.providerSpecificData.connectionProxyEnabled = proxyConfig.connectionProxyEnabled;
        updateData.providerSpecificData.connectionProxyUrl = proxyConfig.connectionProxyUrl;
        updateData.providerSpecificData.connectionNoProxy = proxyConfig.connectionNoProxy;
      }

      if (proxyPoolResult.hasProxyPoolField) {
        if (proxyPoolResult.proxyPoolId === null) {
          delete updateData.providerSpecificData.proxyPoolId;
        } else {
          updateData.providerSpecificData.proxyPoolId = proxyPoolResult.proxyPoolId;
        }
      }
    }

    const updated = await updateProviderConnection(id, updateData);

    // T1.5 §B2: the row can be deleted between the `existing` snapshot above
    // and this write — updateProviderConnection then returns null and
    // `{...updated}` used to spread it into `{}` → 200 {connection:{}}.
    // The lost-update on providerSpecificData inside the same read-merge-write
    // window stays a documented, accepted trade-off (T3.3 reduced its surface);
    // full optimistic locking is deliberately NOT introduced here.
    if (!updated) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    invalidateLocalBalanceCache(id);

    return NextResponse.json({ connection: toProviderConnectionResponse(updated) });
  } catch (error) {
    console.log("Error updating connection:", error);
    return NextResponse.json({ error: "Failed to update connection" }, { status: 500 });
  }
}

// DELETE /api/providers/[id] - Delete connection
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteProviderConnection(id);
    if (!deleted) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Connection deleted successfully" });
  } catch (error) {
    console.log("Error deleting connection:", error);
    return NextResponse.json({ error: "Failed to delete connection" }, { status: 500 });
  }
}
