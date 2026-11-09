import { z } from "zod";

const keySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const textSchema = z.string().trim().min(1).max(1_000);
const probabilitySchema = z.number().finite().min(0).max(1);
const confidenceSchema = probabilitySchema.nullable();
const choiceProbabilityMapSchema = z.record(keySchema, probabilitySchema)
  .refine((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 12);
const scoreKeySchema = z.string().regex(/^([0-9]|1[01])$/);
const scoreProbabilityMapSchema = z.record(scoreKeySchema, probabilitySchema)
  .refine((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 12);

const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: probabilitySchema,
  probabilities: z.object({ false: probabilitySchema, true: probabilitySchema }).strict(),
  confidence: z.null(),
}).strict();
const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: keySchema,
  probabilities: choiceProbabilityMapSchema,
  confidence: confidenceSchema,
}).strict();
const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number().finite().nonnegative(),
  legend: z.record(scoreKeySchema, textSchema)
    .refine((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 12),
  probabilities: scoreProbabilityMapSchema,
  confidence: confidenceSchema,
}).strict();

export const JevAnswerSchema = z.discriminatedUnion("type", [
  noulAnswerSchema,
  choiceAnswerSchema,
  scoreAnswerSchema,
]);

export const JevDecisionResultSchema = z.object({
  model: z.string().min(1).max(200),
  answers: z.record(keySchema, JevAnswerSchema),
}).strict();
