import { createFileRoute } from "@tanstack/react-router";
import { EvaluationPage } from "../pages/evaluation-page";

export const Route = createFileRoute("/evaluation")({ component: EvaluationPage });
