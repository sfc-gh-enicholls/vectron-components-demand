import Link from "next/link";
import { ArrowRight, Bot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SEVERITY_CLASSES } from "@/lib/format";
import { cn } from "@/lib/utils";

interface AgentRecommendationLinkProps {
  proposalId: string;
  priority: string;
  proposalType?: string | null;
  confidence?: number | null;
  compact?: boolean;
}

function typeLabel(value: string | null | undefined) {
  if (!value) return "recommendation";
  return value.replace(/_/g, " ");
}

export function AgentRecommendationLink({
  proposalId,
  priority,
  proposalType,
  confidence,
  compact = false,
}: AgentRecommendationLinkProps) {
  return (
    <Link
      href={`/agent?proposalId=${encodeURIComponent(proposalId)}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1",
        "text-xs text-foreground transition-colors hover:bg-accent-subtle focus-visible:outline-none",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
      )}
    >
      <Bot size={12} className="text-accent" aria-hidden="true" />
      <span className="font-medium">Agent has a recommendation</span>
      {!compact && proposalType && (
        <span className="text-text-tertiary">{typeLabel(proposalType)}</span>
      )}
      <Badge className={cn("border-0", SEVERITY_CLASSES[priority] ?? "bg-neutral-subtle text-neutral")}> 
        {priority}
      </Badge>
      {confidence !== null && confidence !== undefined && (
        <span className="tabular-nums text-text-tertiary">
          {(confidence * 100).toFixed(0)}%
        </span>
      )}
      <ArrowRight size={11} aria-hidden="true" />
    </Link>
  );
}