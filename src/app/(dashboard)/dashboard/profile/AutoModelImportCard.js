"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Card, Button, Toggle, Select } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";

export default function AutoModelImportCard() {
  const [loading, setLoading] = useState(true);
  const [autoImportSettings, setAutoImportSettings] = useState({
    enabled: false,
    hour: 4,
    lastRunAt: null,
    lastResult: null,
  });
  const [importRules, setImportRules] = useState({});
  const [saving, setSaving] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/models/import/auto");
      if (res.ok) {
        const data = await res.json();
        setAutoImportSettings(data.settings);
        setImportRules(data.rules || {});
      } else {
        setError("Failed to load auto-import settings");
      }
    } catch (err) {
      setError("An error occurred while loading settings");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Load settings on mount
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSettings();
  }, []);

  const handleToggle = async (enabled) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoModelImport: { ...autoImportSettings, enabled },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setAutoImportSettings((prev) => ({
          ...prev,
          enabled: data.autoModelImport?.enabled ?? enabled,
        }));
      } else {
        setError("Failed to update auto-import setting");
      }
    } catch (err) {
      setError("An error occurred");
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleHourChange = async (e) => {
    const hour = parseInt(e.target.value, 10);
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoModelImport: { ...autoImportSettings, hour },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setAutoImportSettings((prev) => ({
          ...prev,
          hour: data.autoModelImport?.hour ?? hour,
        }));
      } else {
        setError("Failed to update hour setting");
      }
    } catch (err) {
      setError("An error occurred");
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async () => {
    setRunLoading(true);
    setError("");
    try {
      const res = await fetch("/api/models/import/auto", { method: "POST" });

      if (res.ok) {
        const data = await res.json();
        // Update the last run info
        setAutoImportSettings((prev) => ({
          ...prev,
          lastRunAt: data.at,
          lastResult: { at: data.at, providers: data.providers },
        }));
      } else {
        const data = await res.json();
        if (res.status === 409) {
          setError(data.error || "Auto-import is already running");
        } else {
          setError(data.error || "Failed to run auto-import");
        }
      }
    } catch (err) {
      setError("An error occurred while running auto-import");
      console.error(err);
    } finally {
      setRunLoading(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <div className="text-center py-8 text-text-muted">
          <span className="material-symbols-outlined animate-spin text-[24px]">
            progress_activity
          </span>
        </div>
      </Card>
    );
  }

  const hourOptions = Array.from({ length: 24 }, (_, i) => ({
    value: i.toString(),
    label: `${String(i).padStart(2, "0")}:00`,
  }));

  const lastRunAt = autoImportSettings.lastRunAt
    ? new Date(autoImportSettings.lastRunAt).toLocaleString()
    : null;

  const providerIds = Object.keys(importRules);
  const lastResult = autoImportSettings.lastResult;

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="size-10 rounded-lg bg-purple-500/10 text-purple-500 flex items-center justify-center shrink-0">
          <span className="material-symbols-outlined text-[20px]">
            schedule
          </span>
        </div>
        <div>
          <h3 className="text-base sm:text-lg font-semibold">
            Daily Model Auto-Import
          </h3>
          <p className="text-xs sm:text-sm text-text-muted">
            Automatically import new models from configured providers
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {/* Enable toggle */}
        <div className="flex items-start sm:items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">
              Enable daily auto-import
            </p>
            <p className="text-xs sm:text-sm text-text-muted">
              Runs at the scheduled hour every day
            </p>
          </div>
          <Toggle
            checked={autoImportSettings.enabled === true}
            onChange={handleToggle}
            disabled={saving}
          />
        </div>

        {/* Hour selector and run button */}
        {autoImportSettings.enabled && (
          <div className="flex flex-col sm:flex-row gap-3 items-end">
            <div className="flex-1 min-w-0">
              <Select
                label="Run time (UTC)"
                options={hourOptions}
                value={String(autoImportSettings.hour ?? 4)}
                onChange={handleHourChange}
                disabled={saving}
              />
            </div>
            <Button
              onClick={handleRunNow}
              loading={runLoading}
              className="w-full sm:w-auto"
            >
              Run now
            </Button>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {/* Last run info */}
        {lastRunAt && lastResult && (
          <div className="pt-4 border-t border-border">
            <p className="text-sm font-medium mb-2">Last run: {lastRunAt}</p>
            <div className="space-y-2">
              {lastResult.providers && lastResult.providers.length > 0 ? (
                lastResult.providers.map((provider) => (
                  <div
                    key={provider.providerId}
                    className="flex items-start justify-between p-2 rounded-lg bg-surface-2"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs sm:text-sm font-medium">
                        {provider.providerId}
                      </p>
                      <p className="text-xs text-text-muted">
                        {provider.imported || 0} imported, {provider.failed || 0}{" "}
                        failed
                      </p>
                      {provider.error && (
                        <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                          {provider.error}
                        </p>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-xs text-text-muted">No providers ran</p>
              )}
            </div>
          </div>
        )}

        {/* Rules list */}
        {providerIds.length > 0 && (
          <div className="pt-4 border-t border-border">
            <p className="text-sm font-medium mb-2">Import rules</p>
            <div className="space-y-2">
              {providerIds.map((providerId) => {
                const rule = importRules[providerId];
                return (
                  <Link
                    key={providerId}
                    href={`/dashboard/providers/${providerId}`}
                  >
                    <div className="flex items-start justify-between p-2 rounded-lg bg-surface-2 hover:bg-surface-3 transition-colors cursor-pointer">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs sm:text-sm font-medium text-primary hover:underline">
                          {providerId}
                        </p>
                        {rule?.testFirst && (
                          <p className="text-xs text-text-muted">
                            Tests before import
                          </p>
                        )}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {providerIds.length === 0 && (
          <div className="pt-4 border-t border-border">
            <p className="text-sm text-text-muted">
              No providers have an auto-import rule yet.
            </p>
          </div>
        )}

        {/* Info note */}
        <div className="p-3 rounded-lg bg-bg border border-border">
          <p className="text-xs text-text-muted leading-relaxed">
            Rules are saved from each provider&apos;s Import models dialog.
            Auto-import only adds new models; it never removes any.
          </p>
        </div>
      </div>
    </Card>
  );
}
