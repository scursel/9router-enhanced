"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import Toggle from "@/shared/components/Toggle";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import Select from "@/shared/components/Select";
import {
  hasLocalBalanceConfigured,
  validateLocalBalancePatch,
} from "open-sse/services/usage/localBalanceMath.js";

function buildInitialLocalBalance(connection) {
  const savedLb = connection?.providerSpecificData?.localBalance;
  if (savedLb && typeof savedLb === "object") {
    return {
      enabled: savedLb.enabled === true,
      currency: savedLb.currency === "USD" ? "USD" : "BRL",
      initialAmount: savedLb.initialAmount != null ? String(savedLb.initialAmount) : "",
      fxMode: savedLb.fxMode === "auto" ? "auto" : "manual",
      fxRate: savedLb.fxRate != null ? String(savedLb.fxRate) : "",
      fxMarkupPct: savedLb.fxMarkupPct != null ? String(savedLb.fxMarkupPct) : "0",
      enforcement: savedLb.enforcement === "block" ? "block" : "track",
      stopAtPct: savedLb.stopAtPct != null ? String(savedLb.stopAtPct) : "100",
      since: savedLb.since || null,
    };
  }
  return {
    enabled: false,
    currency: "BRL",
    initialAmount: "",
    fxMode: "manual",
    fxRate: "",
    fxMarkupPct: "0",
    enforcement: "track",
    stopAtPct: "100",
    since: null,
  };
}

function EditConnectionModalBody({ connection, onSave, onClose }) {
  const psd = connection?.providerSpecificData || {};
  const providerCfg = AI_PROVIDERS?.[connection?.provider];

  const [formData, setFormData] = useState(() => ({
    name: connection?.name || "",
    priority: connection?.priority || 1,
    apiKey: "",
  }));
  const [azureData, setAzureData] = useState(() => ({
    azureEndpoint: connection?.provider === "azure" ? (psd.azureEndpoint || "") : "",
    apiVersion: connection?.provider === "azure" ? (psd.apiVersion || "2024-10-01-preview") : "2024-10-01-preview",
    deployment: connection?.provider === "azure" ? (psd.deployment || "") : "",
    organization: connection?.provider === "azure" ? (psd.organization || "") : "",
  }));
  const [cloudflareData, setCloudflareData] = useState(() => ({
    accountId: connection?.provider === "cloudflare-ai" ? (psd.accountId || "") : "",
  }));
  const [awsData, setAwsData] = useState(() => ({
    profile: providerCfg?.credentialForm === "aws" ? (psd.profile || "") : "",
    region: providerCfg?.credentialForm === "aws" ? (psd.region || "") : "",
    accessKeyId: providerCfg?.credentialForm === "aws" ? (psd.accessKeyId || "") : "",
    sessionToken: "",
  }));
  const [clearAwsSessionToken, setClearAwsSessionToken] = useState(false);
  const [region, setRegion] = useState(() => (
    providerCfg?.regions
      ? (psd.region || providerCfg.defaultRegion || providerCfg.regions[0]?.id || "")
      : ""
  ));
  const [localBalance, setLocalBalance] = useState(() => buildInitialLocalBalance(connection));
  const [quickActionAmount, setQuickActionAmount] = useState("");
  const [fxLookup, setFxLookup] = useState({ loading: false, info: null, error: null });
  const [balanceError, setBalanceError] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);

  const isOAuth = connection?.authType === "oauth";
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const usesAwsCredentialForm = AI_PROVIDERS?.[connection?.provider]?.credentialForm === "aws";
  const isCompatible = connection
    ? (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider))
    : false;
  const providerRegions = connection ? (AI_PROVIDERS?.[connection.provider]?.regions || null) : null;

  // Build providerSpecificData for region-aware providers without spreading unrelated keys
  const buildRegionSpecificData = () => {
    if (providerRegions && region) return { region };
    return undefined;
  };

  // The server keeps a saved session token when this password field is blank. Other empty
  // fields still clear their saved values so a profile can be switched to static keys.
  const buildAwsSpecificData = () => ({
    profile: awsData.profile.trim(),
    region: awsData.region.trim(),
    accessKeyId: awsData.accessKeyId.trim(),
    sessionToken: clearAwsSessionToken ? null : awsData.sessionToken.trim(),
  });

  const handleTest = async () => {
    if (!connection?.provider) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/providers/${connection.id}/test`, { method: "POST" });
      const data = await res.json();
      setTestResult(data.valid ? "success" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  const handleValidate = async () => {
    if (!connection?.provider || !formData.apiKey) return;
    setValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: connection.provider,
          apiKey: formData.apiKey,
          ...(isAzure ? { providerSpecificData: azureData } : {}),
          ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
          ...(usesAwsCredentialForm ? { providerSpecificData: buildAwsSpecificData() } : {}),
          ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
        }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  const handleFetchFxRate = async (forceRefresh = true) => {
    setFxLookup({ loading: true, info: null, error: null });
    try {
      const url = forceRefresh ? "/api/fx/usd-brl?refresh=1" : "/api/fx/usd-brl";
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok || !Number.isFinite(Number(data?.rate))) {
        setFxLookup({
          loading: false,
          info: null,
          error: data?.error || "Não foi possível obter a cotação USD/BRL",
        });
        return;
      }
      setLocalBalance((prev) => ({
        ...prev,
        fxRate: Number(data.rate).toFixed(4),
      }));
      setFxLookup({
        loading: false,
        info: `1 USD = R$ ${Number(data.rate).toFixed(4)} (${data.source}${data.stale ? ", cache" : ""})`,
        error: null,
      });
    } catch {
      setFxLookup({
        loading: false,
        info: null,
        error: "Erro de rede ao consultar cotação USD/BRL",
      });
    }
  };

  const handleToggleLocalBalance = (nextEnabled) => {
    setBalanceError(null);
    setLocalBalance((prev) => ({
      ...prev,
      enabled: nextEnabled,
      since: prev.since || (nextEnabled ? new Date().toISOString() : null),
    }));
    if (nextEnabled && localBalance.currency === "BRL" && !localBalance.fxRate) {
      handleFetchFxRate(false);
    }
  };

  const handleQuickBalanceAction = async (type) => {
    if (!connection) return;
    setBalanceError(null);
    const amount = Number.parseFloat(quickActionAmount);
    if (!Number.isFinite(amount) || (type === "calibrate" ? amount < 0 : amount <= 0)) {
      setBalanceError(
        type === "calibrate"
          ? "Informe um saldo atual válido (>= 0) para ajustar."
          : "Informe um valor positivo (> 0) para adicionar crédito."
      );
      return;
    }
    const parsedFx = Number.parseFloat(localBalance.fxRate);
    const actionPayload = {
      type,
      amount,
      ...(type === "calibrate" &&
      localBalance.currency === "BRL" &&
      Number.isFinite(parsedFx) &&
      parsedFx > 0
        ? { fxRate: parsedFx }
        : {}),
    };
    setSaving(true);
    try {
      await onSave({ localBalanceAction: actionPayload });
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async () => {
    if (!connection) return;
    setBalanceError(null);

    let nextLocalBalancePatch;
    if (!isOAuth) {
      if (localBalance.enabled) {
        const isBrl = localBalance.currency === "BRL";
        const candidate = {
          enabled: true,
          currency: localBalance.currency,
          initialAmount: Number.parseFloat(localBalance.initialAmount),
          since: localBalance.since || new Date().toISOString(),
          fxMode: isBrl ? localBalance.fxMode : "manual",
          fxRate: isBrl ? Number.parseFloat(localBalance.fxRate) : 1,
          fxMarkupPct: isBrl ? (Number.parseFloat(localBalance.fxMarkupPct) || 0) : 0,
          enforcement: localBalance.enforcement,
          stopAtPct: Number.parseInt(localBalance.stopAtPct, 10) || 100,
        };
        const check = validateLocalBalancePatch(candidate);
        if (!check.valid) {
          setBalanceError(check.error);
          return;
        }
        nextLocalBalancePatch = check.value;
      } else if (connection.providerSpecificData?.localBalance) {
        nextLocalBalancePatch = null;
      }
    }

    setSaving(true);
    try {
      const updates = {
        name: formData.name,
        priority: formData.priority,
      };
      if (!isOAuth && formData.apiKey) {
        updates.apiKey = formData.apiKey;
        let isValid = validationResult === "success";
        if (!isValid) {
          try {
            setValidating(true);
            setValidationResult(null);
            const res = await fetch("/api/providers/validate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: connection.provider,
                apiKey: formData.apiKey,
                ...(isAzure ? { providerSpecificData: azureData } : {}),
                ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
                ...(usesAwsCredentialForm ? { providerSpecificData: buildAwsSpecificData() } : {}),
                ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
              }),
            });
            const data = await res.json();
            isValid = !!data.valid;
            setValidationResult(isValid ? "success" : "failed");
          } catch {
            setValidationResult("failed");
          } finally {
            setValidating(false);
          }
        }
        if (isValid) {
          updates.testStatus = "active";
          updates.lastError = null;
          updates.lastErrorAt = null;
        }
      }

      // Merge providerSpecificData cleanly so section builders never overwrite each other
      const nextPsd = {};
      if (isAzure) {
        Object.assign(nextPsd, {
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        });
      }
      if (isCloudflareAi) {
        nextPsd.accountId = cloudflareData.accountId;
      }
      if (usesAwsCredentialForm) {
        Object.assign(nextPsd, buildAwsSpecificData());
      }
      if (providerRegions && region) {
        nextPsd.region = region;
      }
      if (nextLocalBalancePatch !== undefined) {
        nextPsd.localBalance = nextLocalBalancePatch;
      }
      if (Object.keys(nextPsd).length > 0) {
        updates.providerSpecificData = nextPsd;
      }

      await onSave(updates);
    } finally {
      setSaving(false);
    }
  };

  return (
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (
          <div className="bg-sidebar/50 p-3 rounded-lg">
            <p className="text-sm text-text-muted mb-1">Email</p>
            <p className="font-medium">{connection.email}</p>
          </div>
        )}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })}
        />

        {!isOAuth && (
          <>
            <div className="flex gap-2">
              <Input
                label="API Key"
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="Enter new API key"
                hint="Leave blank to keep the current API key."
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <Badge variant={validationResult === "success" ? "success" : "error"}>
                {validationResult === "success" ? "Valid" : "Invalid"}
              </Badge>
            )}
          </>
        )}

        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {usesAwsCredentialForm && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">AWS Bedrock Credentials</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="AWS Profile (SSO — recommended)"
                value={awsData.profile}
                onChange={(e) => setAwsData({ ...awsData, profile: e.target.value })}
                placeholder="my-sso-profile"
                hint="Clear this to use static keys instead; a profile takes precedence."
              />
              <Input
                label="Region"
                value={awsData.region}
                onChange={(e) => setAwsData({ ...awsData, region: e.target.value })}
                placeholder="us-east-1"
              />
              <Input
                label="Access Key ID (only for static keys)"
                value={awsData.accessKeyId}
                onChange={(e) => setAwsData({ ...awsData, accessKeyId: e.target.value })}
                placeholder="AKIA..."
              />
              <Input
                label="Session Token (only for temporary ASIA… keys)"
                type="password"
                value={awsData.sessionToken}
                onChange={(e) => setAwsData({ ...awsData, sessionToken: e.target.value })}
                placeholder="FwoGZXIvYXdz..."
                hint="Leave blank to keep the saved token. Enter a new token to replace it."
                disabled={clearAwsSessionToken}
              />
              <label className="flex items-center gap-2 text-sm text-text-muted">
                <input
                  type="checkbox"
                  checked={clearAwsSessionToken}
                  onChange={(e) => {
                    setClearAwsSessionToken(e.target.checked);
                    if (e.target.checked) setAwsData({ ...awsData, sessionToken: "" });
                  }}
                />
                Remove saved session token
              </label>
            </div>
          </div>
        )}

        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
          />
        )}

        {!isOAuth && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-black/10 dark:border-white/10 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold text-sm">Saldo / Orçamento Local</h3>
                <p className="text-xs text-text-muted">
                  Acompanha e limita gasto estimado por conexão no Quota Tracker.
                </p>
              </div>
              <Toggle
                size="sm"
                checked={localBalance.enabled}
                onChange={handleToggleLocalBalance}
                disabled={saving}
              />
            </div>

            {localBalance.enabled && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Select
                    label="Moeda"
                    value={localBalance.currency}
                    onChange={(e) => {
                      const nextCur = e.target.value === "USD" ? "USD" : "BRL";
                      setBalanceError(null);
                      setLocalBalance((prev) => ({ ...prev, currency: nextCur }));
                      if (nextCur === "BRL" && !localBalance.fxRate) {
                        handleFetchFxRate(false);
                      }
                    }}
                    options={[
                      { value: "BRL", label: "BRL (R$)" },
                      { value: "USD", label: "USD (US$)" },
                    ]}
                  />
                  <Input
                    label={`Saldo disponível (${localBalance.currency})`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={localBalance.initialAmount}
                    onChange={(e) => {
                      setBalanceError(null);
                      setLocalBalance((prev) => ({ ...prev, initialAmount: e.target.value }));
                    }}
                    placeholder="150.00"
                  />
                </div>

                {localBalance.currency === "BRL" && (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Select
                        label="Câmbio USD → BRL"
                        value={localBalance.fxMode}
                        onChange={(e) => setLocalBalance((prev) => ({ ...prev, fxMode: e.target.value === "auto" ? "auto" : "manual" }))}
                        options={[
                          { value: "manual", label: "Manual — taxa fixa (recomendado)" },
                          { value: "auto", label: "Automática — cotação do dia" },
                        ]}
                      />
                      <Input
                        label="Margem IOF/spread (%)"
                        type="number"
                        step="0.1"
                        min="0"
                        max="100"
                        value={localBalance.fxMarkupPct}
                        onChange={(e) => setLocalBalance((prev) => ({ ...prev, fxMarkupPct: e.target.value }))}
                        placeholder="0"
                      />
                    </div>
                    <div className="flex gap-2 items-start">
                      <Input
                        label="Cotação USD → BRL (fallback/fixa)"
                        type="number"
                        step="0.0001"
                        min="0.01"
                        value={localBalance.fxRate}
                        onChange={(e) => {
                          setBalanceError(null);
                          setLocalBalance((prev) => ({ ...prev, fxRate: e.target.value }));
                        }}
                        placeholder="5.80"
                        className="flex-1"
                      />
                      <div className="pt-7">
                        <Button
                          type="button"
                          onClick={() => handleFetchFxRate(true)}
                          variant="secondary"
                          disabled={fxLookup.loading || saving}
                        >
                          {fxLookup.loading ? "Buscando..." : "Buscar cotação"}
                        </Button>
                      </div>
                    </div>
                    {fxLookup.info && (
                      <p className="text-xs text-text-muted">{fxLookup.info}</p>
                    )}
                    {fxLookup.error && (
                      <p className="text-xs text-red-500">{fxLookup.error}</p>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Select
                    label="Ao atingir o limite"
                    value={localBalance.enforcement}
                    onChange={(e) => setLocalBalance((prev) => ({ ...prev, enforcement: e.target.value === "block" ? "block" : "track" }))}
                    options={[
                      { value: "track", label: "Apenas monitorar" },
                      { value: "block", label: "Pausar conta / fallback" },
                    ]}
                  />
                  {localBalance.enforcement === "block" && (
                    <Input
                      label="Pausar ao atingir (%)"
                      type="number"
                      step="1"
                      min="1"
                      max="100"
                      value={localBalance.stopAtPct}
                      onChange={(e) => setLocalBalance((prev) => ({ ...prev, stopAtPct: e.target.value }))}
                      placeholder="100"
                    />
                  )}
                </div>

                {hasLocalBalanceConfigured(connection) && (
                  <div className="border-t border-black/10 dark:border-white/10 pt-3 flex flex-col gap-2">
                    <p className="text-xs font-medium text-text-main">Ajuste rápido atômico</p>
                    <div className="flex flex-wrap gap-2 items-end">
                      <Input
                        label={`Valor (${localBalance.currency})`}
                        type="number"
                        step="0.01"
                        min="0"
                        value={quickActionAmount}
                        onChange={(e) => {
                          setBalanceError(null);
                          setQuickActionAmount(e.target.value);
                        }}
                        placeholder="50.00"
                        className="flex-1 min-w-[120px]"
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={saving}
                        onClick={() => handleQuickBalanceAction("calibrate")}
                      >
                        Ajustar saldo atual
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={saving}
                        onClick={() => handleQuickBalanceAction("topup")}
                      >
                        + Adicionar crédito
                      </Button>
                    </div>
                  </div>
                )}

                {balanceError && (
                  <p className="text-xs text-red-500">{balanceError}</p>
                )}

                <p className="text-[11px] leading-relaxed text-text-muted">
                  Estimativa local pelos tokens gravados no 9Router (limite suave em chamadas paralelas). Uso fora do 9Router ou TTS nativo via /v1beta não entra automaticamente; em chaves free-tier o gasto exibido é fictício.
                </p>
              </>
            )}
          </div>
        )}

        {!isCompatible && !isAzure && !isCloudflareAi && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult && (
              <Badge variant={testResult === "success" ? "success" : "error"}>
                {testResult === "success" ? "Valid" : "Failed"}
              </Badge>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
  );
}

export default function EditConnectionModal({ isOpen, connection, onSave, onClose }) {
  if (!connection) return null;

  return (
    <Modal isOpen={isOpen} title="Edit Connection" onClose={onClose}>
      {isOpen && (
        <EditConnectionModalBody
          key={connection.id || "edit"}
          connection={connection}
          onSave={onSave}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

EditConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    priority: PropTypes.number,
    authType: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.object,
  }),
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  })),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
