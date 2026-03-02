"use client";

import { useMemo, useState } from "react";
import { type ThemePreference, useTheme } from "@/app/providers";
import {
  DEFAULT_SANDBOX_TYPE,
  type SandboxType,
} from "@/components/sandbox-selector-compact";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { type ModelOption, useModelOptions } from "@/hooks/use-model-options";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { DEFAULT_MODEL_ID } from "@/lib/models";

const SANDBOX_OPTIONS: Array<{ id: SandboxType; name: string }> = [
  { id: "hybrid", name: "Hybrid" },
  { id: "vercel", name: "Vercel" },
  { id: "just-bash", name: "Just Bash" },
];

const THEME_OPTIONS: Array<{ id: ThemePreference; name: string }> = [
  { id: "system", name: "System" },
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];

function isThemePreference(value: string): value is ThemePreference {
  return THEME_OPTIONS.some((option) => option.id === value);
}

function withMissingSelectedOption(
  options: ModelOption[],
  selectedModelId: string,
): ModelOption[] {
  if (options.some((option) => option.id === selectedModelId)) {
    return options;
  }

  return [
    {
      id: selectedModelId,
      label: `${selectedModelId} (missing)`,
      description: "This model or variant no longer exists",
      isVariant: selectedModelId.startsWith("variant:"),
    },
    ...options,
  ];
}

export function PreferencesSectionSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent Preferences</CardTitle>
        <CardDescription>
          Default settings for new sessions. You can override these when
          starting a session or chat.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-2">
          <Label htmlFor="appearance">Appearance</Label>
          <Select disabled>
            <SelectTrigger id="appearance" className="w-full max-w-xs">
              <Skeleton className="h-4 w-24" />
            </SelectTrigger>
          </Select>
          <p className="text-xs text-muted-foreground">
            Choose between light and dark mode.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="model">Default Model</Label>
          <Select disabled>
            <SelectTrigger id="model" className="w-full max-w-xs">
              <Skeleton className="h-4 w-32" />
            </SelectTrigger>
          </Select>
          <p className="text-xs text-muted-foreground">
            The AI model used for new chats.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="sandbox">Default Sandbox</Label>
          <Select disabled>
            <SelectTrigger id="sandbox" className="w-full max-w-xs">
              <Skeleton className="h-4 w-28" />
            </SelectTrigger>
          </Select>
          <p className="text-xs text-muted-foreground">
            The execution environment for new sessions.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function PreferencesSection() {
  const { theme, setTheme } = useTheme();
  const { preferences, loading, updatePreferences } = useUserPreferences();
  const { modelOptions, loading: modelOptionsLoading } = useModelOptions();
  const [isSaving, setIsSaving] = useState(false);

  const defaultModelValue = preferences?.defaultModelId ?? DEFAULT_MODEL_ID;
  const subagentModelValue = preferences?.defaultSubagentModelId ?? "auto";

  const modelOptionsWithVariants = useMemo(() => {
    const userVariants = preferences?.modelVariants ?? [];

    if (userVariants.length === 0) {
      return modelOptions;
    }

    const optionIds = new Set(modelOptions.map((option) => option.id));
    const missingVariantOptions: ModelOption[] = userVariants
      .filter((variant) => !optionIds.has(variant.id))
      .map((variant) => ({
        id: variant.id,
        label: variant.name,
        description: `Variant of ${variant.baseModelId}`,
        isVariant: true,
      }));

    return [...modelOptions, ...missingVariantOptions];
  }, [modelOptions, preferences?.modelVariants]);

  const defaultModelOptions = useMemo(
    () =>
      withMissingSelectedOption(modelOptionsWithVariants, defaultModelValue),
    [defaultModelValue, modelOptionsWithVariants],
  );

  const subagentModelOptions = useMemo(
    () =>
      subagentModelValue === "auto"
        ? modelOptionsWithVariants
        : withMissingSelectedOption(
            modelOptionsWithVariants,
            subagentModelValue,
          ),
    [modelOptionsWithVariants, subagentModelValue],
  );

  const handleThemeChange = (nextTheme: string) => {
    if (isThemePreference(nextTheme)) {
      setTheme(nextTheme);
    }
  };

  const handleModelChange = async (modelId: string) => {
    setIsSaving(true);
    try {
      await updatePreferences({ defaultModelId: modelId });
    } catch (error) {
      console.error("Failed to update model preference:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSubagentModelChange = async (value: string) => {
    setIsSaving(true);
    try {
      await updatePreferences({
        defaultSubagentModelId: value === "auto" ? null : value,
      });
    } catch (error) {
      console.error("Failed to update subagent model preference:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSandboxChange = async (sandboxType: SandboxType) => {
    setIsSaving(true);
    try {
      await updatePreferences({ defaultSandboxType: sandboxType });
    } catch (error) {
      console.error("Failed to update sandbox preference:", error);
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return <PreferencesSectionSkeleton />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent Preferences</CardTitle>
        <CardDescription>
          Default settings for new sessions. You can override these when
          starting a session or chat.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-2">
          <Label htmlFor="appearance">Appearance</Label>
          <Select value={theme} onValueChange={handleThemeChange}>
            <SelectTrigger id="appearance" className="w-full max-w-xs">
              <SelectValue placeholder="Select an appearance" />
            </SelectTrigger>
            <SelectContent>
              {THEME_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Choose between light and dark mode. This preference is saved in your
            current browser.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="model">Default Model</Label>
          <Select
            value={defaultModelValue}
            onValueChange={handleModelChange}
            disabled={isSaving || modelOptionsLoading}
          >
            <SelectTrigger id="model" className="w-full max-w-xs">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {defaultModelOptions.map((modelOption) => (
                <SelectItem key={modelOption.id} value={modelOption.id}>
                  {modelOption.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            The AI model used for new chats. Includes model variants from
            Settings → Model Variants.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="subagent-model">Subagent Model</Label>
          <Select
            value={subagentModelValue}
            onValueChange={handleSubagentModelChange}
            disabled={isSaving || modelOptionsLoading}
          >
            <SelectTrigger id="subagent-model" className="w-full max-w-xs">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Same as main model</SelectItem>
              {subagentModelOptions.map((modelOption) => (
                <SelectItem key={modelOption.id} value={modelOption.id}>
                  {modelOption.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            The AI model used for explorer and executor subagents. Defaults to
            the main model if not set.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="sandbox">Default Sandbox</Label>
          <Select
            value={preferences?.defaultSandboxType ?? DEFAULT_SANDBOX_TYPE}
            onValueChange={(value) => handleSandboxChange(value as SandboxType)}
            disabled={isSaving}
          >
            <SelectTrigger id="sandbox" className="w-full max-w-xs">
              <SelectValue placeholder="Select a sandbox type" />
            </SelectTrigger>
            <SelectContent>
              {SANDBOX_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            The execution environment for new sessions.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
