import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Level = "Below" | "On Level" | "Advanced";
type ChoiceLetter = "A" | "B" | "C" | "D";
type Subject = "Reading" | "Math" | "Science" | "Social Studies";
type Mode = "Practice" | "Cross-Curricular" | "Tutor" | "Answer Key";

type CrossSubject = "Reading" | "Math" | "Science";

type Question = {
  question: string;
  choices: [string, string, string, string];
  correct_answer: ChoiceLetter;
  explanation: string;
  hint?: string;
  think?: string;
  step_by_step?: string;
  common_mistake?: string;
  parent_tip?: string;
  cross?: {
    subject: CrossSubject;
    connection: string;
  };
};

type WorkerResponse = {
  passage: string;
  questions: Question[];
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LETTERS: ChoiceLetter[] = ["A", "B", "C", "D"];
const READING_DEFAULT_SKILL = "Finding the main idea";

const PLACEHOLDER_PATTERNS = [
  /option that is fully supported/i,
  /generic/i,
  /placeholder/i,
  /best answer is supported by evidence/i,
  /this connects across subjects/i,
  /option \d/i,
  /lorem ipsum/i,
];

function canonicalizeSubject(subject: unknown): Subject {
  const value = String(subject || "").toLowerCase();
  if (value.includes("math")) return "Math";
  if (value.includes("science")) return "Science";
  if (value.includes("social")) return "Social Studies";
  return "Reading";
}

function canonicalizeMode(mode: unknown): Mode {
  const value = String(mode || "").toLowerCase();
  if (value.includes("cross")) return "Cross-Curricular";
  if (value.includes("tutor")) return "Tutor";
  if (value.includes("answer")) return "Answer Key";
  return "Practice";
}

function normalizeLevel(level: unknown): Level {
  const value = String(level || "");
  if (value === "Below" || value === "Advanced") return value;
  return "On Level";
}

function hasPlaceholder(text: string): boolean {
  const value = String(text || "").trim();
  if (!value) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

function containsRepeatedPassageContent(passage: string): boolean {
  const sentences = passage
    .split(/[.!?]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length < 2) return false;
  const seen = new Set<string>();
  for (const sentence of sentences) {
    const key = sentence.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function wordRange(subject: Subject, mode: Mode, grade: number): { min: number; max: number } {
  if (subject === "Science" && mode === "Practice") return { min: 25, max: 70 };
  if (subject === "Social Studies" && mode === "Practice") return { min: 30, max: 80 };
  if (subject === "Math") return { min: 50, max: 120 };
  if (subject === "Reading") return { min: 150, max: 300 };
  if (subject === "Social Studies") return { min: grade <= 4 ? 140 : 160, max: 280 };
  if (subject === "Science" && mode === "Cross-Curricular") return { min: 150, max: 300 };
  return { min: 140, max: 280 };
}

function clampWords(text: string, min: number, max: number): string {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length >= min) return words.slice(0, max).join(" ");

  const seed = cleaned || "Students analyzed evidence from a real scenario and explained their reasoning using specific details.";
  const seedWords = seed.split(" ").filter(Boolean);
  const expanded = [...seedWords];
  while (expanded.length < min) expanded.push(...seedWords);
  return expanded.slice(0, max).join(" ");
}

function readingStructure(skill: string): string {
  const s = skill.toLowerCase();
  if (s.includes("main idea")) {
    return "Q1 main idea; Q2-3 supporting details; Q4 development; Q5 textual evidence.";
  }
  if (s.includes("infer")) {
    return "Q1 inference; Q2-3 clues; Q4 reasoning; Q5 textual evidence.";
  }
  if (s.includes("theme")) {
    return "Q1 theme; Q2-3 events/details; Q4 character action; Q5 textual evidence.";
  }
  return "Q1 core reading target; Q2-3 supports; Q4 reasoning; Q5 evidence.";
}

function rigorPrompt(level: Level): string {
  if (level === "Below") return "Use simpler language, but keep full reasoning depth.";
  if (level === "Advanced") return "Use deeper reasoning and more abstract analysis.";
  return "Use grade-level language and rigorous reasoning.";
}

function crossSubjectsFor(subject: Subject): CrossSubject[] {
  if (subject === "Reading") return ["Science", "Math", "Reading"];
  if (subject === "Science") return ["Reading", "Math", "Science"];
  if (subject === "Math") return ["Science", "Reading", "Math"];
  return ["Reading", "Science", "Math"];
}

function buildPrompt(params: {
  grade: number;
  subject: Subject;
  mode: Mode;
  skill: string;
  level: Level;
}): string {
  const { grade, subject, mode, skill, level } = params;
  const { min, max } = wordRange(subject, mode, grade);

  let behavior = "";

  if (subject === "Science" && mode === "Practice") {
    behavior = `
SCIENCE PRACTICE MODE (STRICT)
- DO NOT generate a long reading passage.
- Use a short scientific scenario or experiment setup (1-3 sentences).
- Questions:
  Q1 concept understanding
  Q2 scenario application
  Q3 cause/effect
  Q4 data interpretation (trend/table language)
  Q5 evidence-based reasoning
- Use real science content (ecosystems, forces, energy, weather, cells, matter, Earth systems).
- No generic wording.`;
  } else if (subject === "Science" && mode === "Cross-Curricular") {
    behavior = `
SCIENCE CROSS-CURRICULAR MODE (STRICT)
- Use a 150-300 word informational READING passage about science content.
- Questions must align to READING skill: ${readingStructure(skill)}
- Every question must include:
  cross.subject in ["Reading", "Math", "Science"]
  cross.connection with real explanation tied to question content.
- Cross-connections must reference real tasks (graphing trends, interpreting text structure, linking historical science policy, etc.).`;
  } else if (subject === "Reading") {
    behavior = `
READING MODE (STRICT)
- Use passage-based reading set (${min}-${max} words).
- Structure: ${readingStructure(skill)}`;
  } else if (subject === "Math") {
    behavior = `
MATH MODE (STRICT)
- Use short real-world context.
- ALL questions must be word problems and at least 2-step reasoning.
- Structure:
  Q1-Q2 multi-step problems
  Q3 conceptual understanding
  Q4 application
  Q5 reasoning/error analysis
- No computation-only questions.`;
  } else if (subject === "Social Studies" && mode === "Cross-Curricular") {
    behavior = `
SOCIAL STUDIES CROSS-CURRICULAR MODE (STRICT)
- Generate a 150-300 word INFORMATIONAL READING passage with history, geography, civics, or economics content.
- Passage must be rich enough for analysis and support all questions.
- Question structure:
  Q1 main idea
  Q2 cause/effect
  Q3 supporting detail
  Q4 reasoning (why/how)
  Q5 evidence-based
- Questions must directly reference passage details.
- Every question must include cross.subject in ["Reading","Science","Math"] with real content-based explanation.`;
  } else if (subject === "Social Studies" && mode === "Practice") {
    behavior = `
SOCIAL STUDIES PRACTICE MODE (STRICT)
- DO NOT generate a long reading passage.
- Generate a short stimulus (1-3 sentences) using one of:
  map description, chart description, primary-source excerpt, historical scenario, political cartoon description.
- Describe visuals in text clearly, for example: "A map shows trade routes with arrows between regions."
- Question structure:
  Q1 main idea/purpose of stimulus
  Q2 cause/effect (historical or geographic)
  Q3 interpretation of map/chart/source
  Q4 reasoning (why/how)
  Q5 evidence-based/application
- Questions must reference the described stimulus directly.`;
  } else {
    behavior = `
SOCIAL STUDIES MODE (STRICT)
- Use informational passage (${min}-${max} words).
- Questions:
  Q1 main idea
  Q2 cause/effect
  Q3 detail/context
  Q4 reasoning
  Q5 evidence`;
  }

  const modeHints = mode === "Tutor"
    ? "For every explanation: name the correct answer explicitly, cite passage/scenario evidence, and explain why at least one wrong answer is incorrect."
    : mode === "Answer Key"
      ? "Provide teacher-ready explanations with common_mistake and parent_tip; still name why one distractor is wrong."
      : "Provide concise but specific explanations tied to content evidence and one incorrect option.";

  const crossRules = mode === "Cross-Curricular"
    ? `Cross-connections required on every question. Allowed cross subjects for this set: ${crossSubjectsFor(subject).join(", ")}.`
    : "Do not include cross unless mode is Cross-Curricular.";

  return `You are a STAAR assessment designer.

INPUT
- Grade: ${grade}
- Subject: ${subject}
- Skill: ${skill}
- Level: ${level}
- Mode: ${mode}

GLOBAL REQUIREMENTS
- Return VALID JSON only.
- Output shape:
  {
    "passage": "",
    "questions": [
      {
        "question": "",
        "choices": ["A. ...","B. ...","C. ...","D. ..."],
        "correct_answer": "A",
        "explanation": "",
        "cross": { "subject": "Math", "connection": "..." }
      }
    ]
  }
- Exactly 5 questions.
- Never empty passage.
- No placeholders, no generic wording, no repeated sentence blocks.
- Answer choices must be plausible and content-specific.
- ${rigorPrompt(level)}
- ${modeHints}
- ${crossRules}

${behavior}

FINAL QUALITY RULES
- Use real nouns, quantities, and concepts.
- Distractors must reflect realistic student mistakes.
- Explanations must be specific, not repetitive.
`;
}

function parseJsonPayload(raw: string): Record<string, unknown> {
  const cleaned = String(raw || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return typeof parsed === "object" && parsed ? parsed as Record<string, unknown> : {};
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return typeof parsed === "object" && parsed ? parsed as Record<string, unknown> : {};
    }
    throw new Error("Malformed model JSON");
  }
}

function normalizeChoices(choices: unknown, fallbackChoices: string[]): [string, string, string, string] {
  const source = Array.isArray(choices) ? choices.slice(0, 4) : fallbackChoices;
  const normalized = source.map((c, i) => {
    const text = String(c || "").trim() || fallbackChoices[i] || `Choice ${i + 1}`;
    return /^[A-D]\.\s*/.test(text) ? text : `${LETTERS[i]}. ${text}`;
  });

  while (normalized.length < 4) {
    const idx = normalized.length;
    normalized.push(`${LETTERS[idx]}. ${fallbackChoices[idx] || "Additional option"}`);
  }

  return normalized.slice(0, 4) as [string, string, string, string];
}

function normalizeAnswer(answer: unknown): ChoiceLetter {
  const value = String(answer || "A").trim().toUpperCase();
  if (value.startsWith("B")) return "B";
  if (value.startsWith("C")) return "C";
  if (value.startsWith("D")) return "D";
  return "A";
}

function exampleScienceScenario(): string {
  return "In a classroom investigation, students placed identical plants under blue, red, and white light for ten days. The red-light plant grew 9 cm, the white-light plant grew 6 cm, and the blue-light plant grew 4 cm.";
}

function fallbackPassage(subject: Subject, mode: Mode, grade: number): string {
  if (subject === "Science" && mode === "Practice") return exampleScienceScenario();

  const { min, max } = wordRange(subject, mode, grade);

  if (subject === "Science" && mode === "Cross-Curricular") {
    return clampWords(
      "A coastal city created a long-term plan to protect neighborhoods from stronger storms and flooding. Scientists monitored sea-surface temperatures, wind patterns, and marsh health to predict where erosion would increase. Engineers compared several barrier designs, while local schools collected rainfall data and graphed trends over five years. Community leaders reviewed historical storm records and budget reports before choosing projects. The final plan combined wetland restoration, improved drainage, and new warning systems. Students reading the report learned how scientific evidence, mathematical data analysis, and social decision-making work together in real life. The report also showed that even small yearly temperature increases can affect ecosystems and public safety when patterns continue over time.",
      min,
      max,
    );
  }

  if (subject === "Reading") {
    return clampWords(
      "Marta joined a neighborhood project that turned an empty lot into a pollinator garden. At first, the group argued about which plants would survive summer heat. Marta read short articles about soil, sunlight, and native species, then created a chart comparing watering needs. She noticed that some flowers attracted bees quickly but wilted after a week, while others stayed healthy and bloomed longer. The team adjusted its plan and planted more native varieties. Within a month, butterflies and bees appeared each morning, and nearby families started visiting the garden after school. Marta explained that small choices, such as selecting local plants, can change a community space. Her teacher asked the class to identify the evidence that best supported Marta's conclusion.",
      min,
      max,
    );
  }

  if (subject === "Math") {
    return clampWords(
      "A school club is organizing a charity run. The club must compare package prices for water bottles, calculate total costs with tax, and decide how many registration fees are needed to cover expenses. Team leaders also need to estimate attendance from last year's data before ordering supplies.",
      min,
      max,
    );
  }

  if (subject === "Social Studies" && mode === "Practice") {
    return "A map description shows arrows carrying cotton and cattle from inland Texas towns to rail hubs, then to Gulf ports. A short newspaper excerpt says rail expansion lowered shipping time and increased market access for farmers.";
  }

  if (subject === "Social Studies" && mode === "Cross-Curricular") {
    return clampWords(
      "In the late 1800s, several Texas communities expanded rail links to connect farms, towns, and ports. Historical records show that local leaders debated how public funds should be used: some favored roads, while others argued for rail lines that could move crops faster to coastal markets. A regional map from the period marks major rivers, rail junctions, and export routes, revealing why geography shaped economic decisions. Census data from nearby counties showed population growth in towns with better transportation access, while civic meeting notes described concerns about taxes and land use. Over time, communities with coordinated infrastructure planning saw gains in trade, employment, and school funding. This case helps readers analyze how geography, economics, and civic choices interact when governments plan long-term development.",
      min,
      max,
    );
  }

  return clampWords(
    "In 1901, a Texas town debated whether to spend limited funds on rail access or irrigation canals. Farmers argued that canals would protect crops during dry months, while merchants believed rail access would increase trade and jobs. Newspaper articles from the period showed that community leaders reviewed maps, crop yields, and shipping costs before voting. The town eventually funded both projects in stages, and records showed that crop production rose while local businesses expanded. Historians use these documents to explain how geography, economics, and civic decision-making shaped the region's development.",
    min,
    max,
  );
}

function fallbackQuestionBlueprint(subject: Subject, mode: Mode, skill: string): Array<{ stem: string; choices: string[]; correct: ChoiceLetter; expl: string }> {
  if (subject === "Science" && mode === "Practice") {
    return [
      {
        stem: "Which scientific concept best explains why the red-light plant grew the most in the investigation?",
        choices: [
          "A. Light wavelength can affect photosynthesis rate in plants",
          "B. Plants grow only when the room temperature changes each day",
          "C. Soil type has no effect when any colored light is used",
          "D. Water amount is unimportant as long as light is bright"
        ],
        correct: "A",
        expl: "Option A is correct because the investigation compares light colors and shows different growth outcomes tied to light conditions; option D is incorrect because water and light both matter for plant growth."
      },
      {
        stem: "If a student repeats the test with yellow light and predicts medium growth, which evidence from the scenario supports that prediction method?",
        choices: [
          "A. The prediction uses existing growth data from multiple light conditions",
          "B. The prediction ignores measured plant heights",
          "C. The prediction assumes all colors produce identical growth",
          "D. The prediction removes the need for a control setup"
        ],
        correct: "A",
        expl: "Option A is correct because using measured outcomes from prior trials is a valid application of scenario data; option C is incorrect because the data clearly show color-based differences."
      },
      {
        stem: "Which cause-and-effect relationship is best supported by the investigation results?",
        choices: [
          "A. Changing light color changed plant growth amounts",
          "B. Measuring plants caused photosynthesis to stop",
          "C. Using equal watering made color irrelevant",
          "D. Plant height differences caused light color to change"
        ],
        correct: "A",
        expl: "Option A is correct because light color was the changed variable and growth differed by condition; option D reverses cause and effect."
      },
      {
        stem: "Based on the growth values (9 cm, 6 cm, 4 cm), which statement best interprets the trend?",
        choices: [
          "A. Growth decreased from red to white to blue light",
          "B. Growth increased equally across all light types",
          "C. Blue light produced the highest growth",
          "D. White and blue produced identical growth"
        ],
        correct: "A",
        expl: "Option A is correct because the numerical data show a descending trend; option B is incorrect because the differences are not equal."
      },
      {
        stem: "Which claim is best supported by evidence from this experiment?",
        choices: [
          "A. Under these conditions, red light supported the greatest plant growth",
          "B. All light colors always produce the same growth in any plant",
          "C. Plant growth can be explained without any measured evidence",
          "D. Light color has no role in controlled plant investigations"
        ],
        correct: "A",
        expl: "Option A is correct because it matches the measured heights in the controlled setup; option B is too broad and not supported by this single experiment."
      }
    ];
  }

  if (subject === "Math") {
    return [
      {
        stem: "A club buys 12 cases of water at $7.50 each and pays 8% tax. If they have a $110 budget, how much money remains?",
        choices: [
          "A. $12.80 remains",
          "B. $20.00 remains",
          "C. $7.20 remains",
          "D. $2.80 remains"
        ],
        correct: "A",
        expl: "Option A is correct because total cost is 12×7.50 = 90, tax is 7.20, and 110 − 97.20 = 12.80; option D ignores most of the remaining balance."
      },
      {
        stem: "Registration is $15 per runner. If fixed costs are $225 and variable cost is $3 per runner for 40 runners, what is net money after expenses?",
        choices: [
          "A. $255",
          "B. $375",
          "C. $345",
          "D. $195"
        ],
        correct: "A",
        expl: "Option A is correct because revenue is 40×15 = 600 and expenses are 225 + (40×3)=345, so 600−345 = 255; option C subtracts incorrectly."
      },
      {
        stem: "Which statement best explains why the club should estimate attendance before ordering supplies?",
        choices: [
          "A. It helps match quantity decisions to projected demand and total cost",
          "B. It removes the need to compare unit prices",
          "C. It guarantees profit even if fees are not collected",
          "D. It makes tax calculations unnecessary"
        ],
        correct: "A",
        expl: "Option A is correct because conceptual planning links demand estimates to cost decisions; option D is incorrect because tax still affects totals."
      },
      {
        stem: "If turnout is 10% higher than the 40-runner forecast, which updated runner count should be used in budget calculations?",
        choices: [
          "A. 44 runners",
          "B. 42 runners",
          "C. 46 runners",
          "D. 48 runners"
        ],
        correct: "A",
        expl: "Option A is correct because 10% of 40 is 4, so updated attendance is 44; option B represents only a 5% increase."
      },
      {
        stem: "A student computed profit by subtracting tax twice from total revenue. Why is this method incorrect?",
        choices: [
          "A. Tax should be applied to purchases once, not deducted repeatedly from revenue",
          "B. Tax should always be added to revenue totals",
          "C. Revenue should be ignored in profit calculations",
          "D. Expenses should be multiplied by runner count twice"
        ],
        correct: "A",
        expl: "Option A is correct because double-counting tax distorts net profit; option D describes a different, unrelated error."
      }
    ];
  }

  if (subject === "Social Studies") {
    if (mode === "Practice") {
      return [
        {
          stem: "What is the main purpose of the map and newspaper stimulus?",
          choices: [
            "A. To show how transportation routes changed trade opportunities",
            "B. To explain how weather patterns damaged all rail systems",
            "C. To describe cultural traditions with no economic impact",
            "D. To prove farmers stopped using regional markets"
          ],
          correct: "A",
          expl: "Option A is correct because the stimulus links mapped routes with market access; option D is incorrect because the text says access increased."
        },
        {
          stem: "Which cause-and-effect relationship is best supported by the stimulus?",
          choices: [
            "A. Rail expansion reduced shipping time, which helped farmers reach more buyers",
            "B. Longer shipping times increased profits immediately",
            "C. Fewer routes created larger markets for inland towns",
            "D. Port access caused rail lines to be removed"
          ],
          correct: "A",
          expl: "Option A is correct because the excerpt directly ties rail growth to faster movement and market access; option B reverses the relationship."
        },
        {
          stem: "Based on the map description, what can be inferred about towns near rail hubs?",
          choices: [
            "A. They likely handled more goods moving toward Gulf ports",
            "B. They were cut off from trade networks",
            "C. They had no reason to track transportation costs",
            "D. They used only river routes and no rail routes"
          ],
          correct: "A",
          expl: "Option A is correct because hub locations and directional arrows indicate concentrated movement; option D conflicts with the rail-focused map stimulus."
        },
        {
          stem: "Why did local leaders likely support investing in rail access according to the stimulus?",
          choices: [
            "A. They expected transportation improvements to strengthen regional economic growth",
            "B. They wanted to eliminate all exports from Gulf ports",
            "C. They believed slower shipping would attract more buyers",
            "D. They planned to replace market trade with subsistence farming"
          ],
          correct: "A",
          expl: "Option A is correct because the source connects faster transport with broader market participation; option C is unsupported and illogical."
        },
        {
          stem: "Which additional evidence would best support the stimulus claim about expanding market access?",
          choices: [
            "A. A chart showing rising export volumes after new rail links opened",
            "B. A poem describing daily life unrelated to trade",
            "C. A weather report from one afternoon",
            "D. A list of town names without route data"
          ],
          correct: "A",
          expl: "Option A is correct because export trends directly test the claim; option D lacks evidence about economic outcomes."
        }
      ];
    }

    return [
      {
        stem: "What is the main idea of the passage about the town's funding choices?",
        choices: [
          "A. Community leaders used evidence to balance transportation and irrigation priorities",
          "B. Farmers refused to participate in local civic meetings",
          "C. Rail lines were built without considering economic data",
          "D. Irrigation projects ended all regional trade"
        ],
        correct: "A",
        expl: "Option A is correct because the passage emphasizes evidence-based civic decisions; option D is unsupported and extreme."
      },
      {
        stem: "Which cause-and-effect relationship is directly described in the text?",
        choices: [
          "A. Funding infrastructure projects led to increased crop output and business growth",
          "B. Newspaper debates eliminated the need for voting",
          "C. Map analysis reduced the town's population immediately",
          "D. Trade growth caused irrigation canals to disappear"
        ],
        correct: "A",
        expl: "Option A is correct because records link project investment to measurable economic outcomes; option B is incorrect because voting still occurred."
      },
      {
        stem: "Which detail best supports the historical context of the town's decision-making process?",
        choices: [
          "A. Leaders reviewed maps, crop yields, and shipping costs before voting",
          "B. Citizens replaced all local records with oral stories",
          "C. Merchants rejected every geographic factor",
          "D. Farmers ended trade routes permanently"
        ],
        correct: "A",
        expl: "Option A is correct because it provides specific documentary evidence of context; option C contradicts the passage."
      },
      {
        stem: "Which inference about civic reasoning is best supported by the passage?",
        choices: [
          "A. Leaders considered both short-term needs and long-term economic impact",
          "B. Leaders preferred random choices over evidence",
          "C. Leaders ignored all competing viewpoints",
          "D. Leaders used only newspaper headlines to decide"
        ],
        correct: "A",
        expl: "Option A is correct because staged funding reflects strategic reasoning; option B conflicts with the text's emphasis on evidence review."
      },
      {
        stem: "Which evidence most strongly supports the conclusion that geography influenced policy decisions?",
        choices: [
          "A. Officials evaluated maps and canal routes alongside trade data",
          "B. Citizens debated school schedules during meetings",
          "C. Families moved without discussing transportation",
          "D. Editors wrote about unrelated national events"
        ],
        correct: "A",
        expl: "Option A is correct because map and route analysis directly ties geography to policy; option D does not address local decisions."
      }
    ];
  }

  if (subject === "Science" && mode === "Cross-Curricular") {
    return [
      {
        stem: "Which statement best captures the main idea of the coastal resilience passage?",
        choices: [
          "A. Communities need scientific evidence, data analysis, and public planning to reduce storm risk",
          "B. Storm protection depends only on building taller walls",
          "C. Historical records are less useful than guessing weather changes",
          "D. Wetland restoration has no relationship to public safety"
        ],
        correct: "A",
        expl: "Option A is correct because the passage combines science, math, and civic planning evidence; option B is too narrow and ignores multiple strategies."
      },
      {
        stem: "What inference is best supported about why students graphed rainfall trends over five years?",
        choices: [
          "A. They needed long-term patterns to evaluate future flood planning decisions",
          "B. They wanted to avoid comparing scientific measurements",
          "C. They used graphs only to reduce project costs instantly",
          "D. They were proving storms never change over time"
        ],
        correct: "A",
        expl: "Option A is correct because long-term data helps infer risk patterns; option D is contradicted by the passage's concern about stronger storms."
      },
      {
        stem: "Which detail best supports the idea that interdisciplinary work improved the final plan?",
        choices: [
          "A. Engineers, scientists, schools, and community leaders each contributed evidence",
          "B. One group made decisions without reviewing any data",
          "C. Historical records were removed from planning documents",
          "D. The plan focused on one neighborhood and ignored all others"
        ],
        correct: "A",
        expl: "Option A is correct because multiple evidence sources are explicitly described; option C conflicts with the text's use of storm records."
      },
      {
        stem: "How does the passage develop the claim that small temperature increases can affect safety?",
        choices: [
          "A. It links ongoing climate patterns to ecosystem changes and flood-risk planning",
          "B. It states that temperatures matter only during one storm",
          "C. It ignores weather evidence and uses opinion",
          "D. It argues math has no role in environmental decisions"
        ],
        correct: "A",
        expl: "Option A is correct because the passage connects trends, ecosystems, and safety decisions; option C is wrong because data collection is central throughout the text."
      },
      {
        stem: "Which evidence from the passage most strongly supports the author's conclusion about effective resilience planning?",
        choices: [
          "A. The city combined wetland restoration, drainage upgrades, and warning systems after reviewing data",
          "B. The city selected one project before analyzing any records",
          "C. The report avoided comparing storm history with current trends",
          "D. The plan rejected school-collected rainfall data"
        ],
        correct: "A",
        expl: "Option A is correct because it cites the integrated, evidence-driven decision process; option B contradicts the passage's multi-source analysis."
      }
    ];
  }

  return [
    {
      stem: `Which statement best expresses the ${skill.toLowerCase().includes("theme") ? "theme" : "main idea"} of the passage?`,
      choices: [
        "A. Marta used evidence to improve the garden plan",
        "B. Marta avoided reading any information",
        "C. The garden failed because no one collaborated",
        "D. Pollinators never returned to the lot"
      ],
      correct: "A",
      expl: "Option A is correct because Marta compares evidence and adjusts the plan; option D is incorrect because the passage states butterflies and bees appeared."
    },
    {
      stem: "Which detail best supports the strongest interpretation of the passage?",
      choices: [
        "A. Marta compared watering needs before choosing native plants",
        "B. The group stopped tracking flower health",
        "C. Families asked to remove the garden",
        "D. The team ignored sunlight conditions"
      ],
      correct: "A",
      expl: "Option A is correct because it provides direct supporting evidence; option D is incorrect because sunlight was part of their planning."
    },
    {
      stem: "Which event most strengthens the author's message about evidence-based decisions?",
      choices: [
        "A. The team changed plant selections after reviewing bloom performance",
        "B. The team selected plants by guessing",
        "C. The team avoided recording observations",
        "D. The team removed all native plants"
      ],
      correct: "A",
      expl: "Option A is correct because revision based on observations demonstrates evidence-driven action; option B contradicts that process."
    },
    {
      stem: "How does the author develop the central idea across the passage?",
      choices: [
        "A. By showing a problem, gathering evidence, revising the plan, and observing results",
        "B. By listing unrelated opinions without outcomes",
        "C. By focusing only on weather terms",
        "D. By presenting one unsupported claim"
      ],
      correct: "A",
      expl: "Option A is correct because the sequence of events shows development from problem to evidence-based solution; option D lacks support in the text."
    },
    {
      stem: "Which evidence best supports Marta's conclusion that small choices can change a community space?",
      choices: [
        "A. Pollinators returned and families started visiting after plant choices were adjusted",
        "B. The lot remained empty after the project",
        "C. The group stopped meeting before any changes occurred",
        "D. The chart showed no differences among plants"
      ],
      correct: "A",
      expl: "Option A is correct because the observed community changes are direct evidence; option B is opposite of what the passage reports."
    }
  ];
}

function addCrossConnections(questions: Question[], subject: Subject): Question[] {
  const allowed = crossSubjectsFor(subject);
  return questions.map((q, idx) => {
    const chosen = allowed[idx % allowed.length];
    const connection =
      chosen === "Math"
        ? "This connects to math because students can graph and compare quantitative trends from the scenario to justify conclusions."
        : chosen === "Reading"
          ? "This connects to reading because students must interpret informational text structure and cite precise evidence for claims."
          : "This connects to science because the question uses evidence about systems, variables, and cause-and-effect relationships.";

    return {
      ...q,
      cross: {
        subject: chosen,
        connection,
      },
    };
  });
}

function sanitizeQuestion(
  raw: Record<string, unknown>,
  fallback: { stem: string; choices: string[]; correct: ChoiceLetter; expl: string },
  mode: Mode,
  index: number,
): Question {
  const choices = normalizeChoices(raw.choices, fallback.choices);
  const correct = normalizeAnswer(raw.correct_answer || fallback.correct);
  const correctChoiceText = choices[LETTERS.indexOf(correct)] ?? choices[0];
  const wrongLetter = LETTERS.find((l) => l !== correct) || "B";
  const wrongChoiceText = choices[LETTERS.indexOf(wrongLetter)] ?? choices[1];

  const rawExpl = String(raw.explanation || "").trim();
  const explanation = rawExpl && !hasPlaceholder(rawExpl)
    ? rawExpl
    : `Option ${correct} is correct because ${correctChoiceText.replace(/^[A-D]\.\s*/, "")} is supported by evidence from the passage or scenario. Option ${wrongLetter} is incorrect because ${wrongChoiceText.replace(/^[A-D]\.\s*/, "")} does not match the evidence.`;

  const question: Question = {
    question: String(raw.question || fallback.stem).trim() || fallback.stem,
    choices,
    correct_answer: correct,
    explanation,
  };

  if (mode === "Tutor" || mode === "Answer Key") {
    question.hint = String(raw.hint || "Underline key evidence before selecting an answer.").trim();
    question.think = String(raw.think || "Match each option to specific evidence, then eliminate unsupported choices.").trim();
    question.step_by_step = String(raw.step_by_step || `1) Read question ${index + 1}. 2) Compare options to evidence. 3) Choose ${correct} and justify it.`).trim();
    question.common_mistake = String(raw.common_mistake || "Choosing an option that sounds familiar but is not fully supported.").trim();
    question.parent_tip = String(raw.parent_tip || "Ask the student to cite one exact detail proving the correct answer.").trim();
  }

  return question;
}

function validateResult(result: WorkerResponse, subject: Subject, mode: Mode): boolean {
  if (!result.passage || !Array.isArray(result.questions) || result.questions.length !== 5) return false;
  if (containsRepeatedPassageContent(result.passage)) return false;
  if (hasPlaceholder(result.passage)) return false;

  for (const q of result.questions) {
    if (!q.question || hasPlaceholder(q.question)) return false;
    if (!Array.isArray(q.choices) || q.choices.length !== 4) return false;
    if (q.choices.some((c) => !c || hasPlaceholder(String(c)))) return false;
    if (!q.explanation || hasPlaceholder(q.explanation)) return false;

    if (mode === "Cross-Curricular") {
      if (!q.cross?.subject || !q.cross?.connection) return false;
      if (hasPlaceholder(q.cross.connection)) return false;
    }
  }

  if (subject === "Science" && mode === "Practice") {
    const words = result.passage.split(/\s+/).filter(Boolean).length;
    if (words > 90) return false;
  }
  if (subject === "Social Studies" && mode === "Practice") {
    const words = result.passage.split(/\s+/).filter(Boolean).length;
    if (words > 100) return false;
    const stimulusMarkers = /(map|chart|source|cartoon|newspaper|document|stimulus|arrows|trade route)/i;
    if (!stimulusMarkers.test(result.passage)) return false;
  }

  return true;
}

function buildFallback(subject: Subject, mode: Mode, skill: string, grade: number): WorkerResponse {
  const base = fallbackQuestionBlueprint(subject, mode, skill).map((f, idx) =>
    sanitizeQuestion({}, f, mode, idx)
  );

  const questions = mode === "Cross-Curricular" ? addCrossConnections(base, subject) : base;

  return {
    passage: fallbackPassage(subject, mode, grade),
    questions,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization") || "" },
        },
      },
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const subject = canonicalizeSubject(body?.subject);
    const mode = canonicalizeMode(body?.mode);
    const level = normalizeLevel(body?.level);
    const grade = Number(body?.grade || 5);

    let skill = String(body?.skill || "").trim();
    if (!skill) skill = subject === "Reading" ? READING_DEFAULT_SKILL : "Core skill";
    if (subject === "Science" && mode === "Cross-Curricular") {
      const s = skill.toLowerCase();
      if (!s.includes("main") && !s.includes("infer") && !s.includes("theme")) {
        skill = READING_DEFAULT_SKILL;
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      console.log("CALLING OPENAI");
      const aiResponse = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          input: buildPrompt({ grade, subject, mode, skill, level }),
          max_output_tokens: 2600,
        }),
        signal: controller.signal,
      });

      console.log("OPENAI STATUS", aiResponse.status);

      if (!aiResponse.ok) {
        throw new Error(`OpenAI request failed: ${aiResponse.status}`);
      }

      const raw = await aiResponse.json();
      const text = raw.output_text || raw.output?.[0]?.content?.[0]?.text || "";
      const parsed = parseJsonPayload(String(text));

      const { min, max } = wordRange(subject, mode, grade);
      const passage = clampWords(String(parsed.passage || ""), min, max);

      const fallbackBlueprint = fallbackQuestionBlueprint(subject, mode, skill);
      const incomingQuestions = Array.isArray(parsed.questions) ? parsed.questions.slice(0, 5) : [];

      const normalized: Question[] = incomingQuestions.map((q, idx) => {
        const rawQ = q && typeof q === "object" ? q as Record<string, unknown> : {};
        return sanitizeQuestion(rawQ, fallbackBlueprint[idx], mode, idx);
      });

      while (normalized.length < 5) {
        const idx = normalized.length;
        normalized.push(sanitizeQuestion({}, fallbackBlueprint[idx], mode, idx));
      }

      let result: WorkerResponse = {
        passage,
        questions: normalized.slice(0, 5),
      };

      if (mode === "Cross-Curricular") {
        result = {
          ...result,
          questions: addCrossConnections(result.questions, subject).map((q, idx) => {
            const rawCross = (normalized[idx]?.cross && typeof normalized[idx].cross === "object") ? normalized[idx].cross : null;
            if (!rawCross?.subject || !rawCross?.connection || hasPlaceholder(rawCross.connection)) return q;
            return {
              ...q,
              cross: {
                subject: rawCross.subject,
                connection: rawCross.connection,
              },
            };
          }),
        };
      }

      if (!validateResult(result, subject, mode)) {
        result = buildFallback(subject, mode, skill, grade);
      }

      if (!result.passage || !Array.isArray(result.questions)) {
        console.log("❌ INVALID FINAL SHAPE");

        result = {
          passage: "Students worked together to solve a problem and learned an important lesson.",
          questions: Array.from({ length: 5 }).map(() => ({
            question: "What is the main idea?",
            choices: [
              "A. Teamwork helps solve problems",
              "B. Working alone is better",
              "C. School is hard",
              "D. Friends are fun"
            ],
            correct_answer: "A",
            explanation: "This answer best matches the central idea."
          }))
        };
      }

      console.log("RETURNING CONTENT");
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (error) {
      console.log("AI FAILURE", error instanceof Error ? error.message : String(error));
      let result = buildFallback(subject, mode, skill, grade);

      if (!validateResult(result, subject, mode)) {
        result = buildFallback(subject, mode, skill, grade);
      }

      if (!result.passage || !Array.isArray(result.questions)) {
        console.log("❌ INVALID FINAL SHAPE");

        result = {
          passage: "Students worked together to solve a problem and learned an important lesson.",
          questions: Array.from({ length: 5 }).map(() => ({
            question: "What is the main idea?",
            choices: [
              "A. Teamwork helps solve problems",
              "B. Working alone is better",
              "C. School is hard",
              "D. Friends are fun"
            ],
            correct_answer: "A",
            explanation: "This answer best matches the central idea."
          }))
        };
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    const result = buildFallback("Reading", "Practice", READING_DEFAULT_SKILL, 5);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
