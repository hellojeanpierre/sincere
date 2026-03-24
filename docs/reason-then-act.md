# When agents stop to think: the science of reasoning between tool calls

**The single most impactful architectural decision in building LLM agents is whether the agent pauses to reason about tool results before acting next.** Research from 2023–2026 converges on a striking finding: inserting explicit "think about what you just got back" steps between tool calls improves agent task success by **18–34 percentage points** across diverse benchmarks—from code generation to web navigation to multi-hop question answering. This isn't a marginal optimization. It's the difference between agents that work and agents that don't. The pattern traces from the foundational ReAct paper (2022) through a rapidly expanding body of work on reflective architectures, and is now embedded in every major AI lab's production guidance for building agents.

---

## The foundational loop: ReAct established that thinking between actions matters

The story begins with **ReAct** (Yao et al., ICLR 2023), the paper that formalized interleaving reasoning traces with tool actions. ReAct augments an agent's action space with "thoughts"—reasoning steps that don't affect the external environment but compose information, decompose goals, track progress, and handle exceptions. The loop runs: Thought → Action → Observation → Thought → Action → ...

The ablation results were decisive. On **ALFWorld** (a text-based household task benchmark), ReAct achieved **71% success** versus roughly **45% for act-only agents**—a 26 percentage point gap from simply adding reasoning steps between actions. On WebShop, ReAct outperformed imitation and reinforcement learning baselines by 10 percentage points. A particularly revealing sub-ablation replaced flexible thoughts with dense, structured environmental feedback (Inner Monologue-style): success dropped from 71% to 53%, demonstrating that **sparse, flexible reasoning** (commonsense, goal decomposition, exception handling) outperforms even rich but rigid environmental summaries.

Three subsequent frameworks built directly on this foundation. **Reflexion** (Shinn et al., NeurIPS 2023) added *inter-episode* reflection—after failing a full task attempt, the agent generates a verbal self-critique stored in episodic memory for the next trial. This pushed AlfWorld performance to **97% (130/134 tasks)** and achieved **91% pass@1** on HumanEval coding benchmarks, surpassing GPT-4's direct performance. **LATS** (Zhou et al., ICML 2024) unified reflection with Monte Carlo Tree Search, enabling the agent to explore multiple reasoning paths and backtrack when tool results indicate a dead end, doubling ReAct's performance on HotPotQA. **CRITIC** (Gou et al., ICLR 2024) introduced tool-interactive critiquing—where the agent uses tools specifically to *verify* its own outputs, then reasons about discrepancies to self-correct—achieving **+5.1 to +8.2 F1** over ReAct on question-answering tasks.

A critical finding from CRITIC established a principle the field has not overturned: **external tool feedback is essential for reliable self-correction**. The model's own critiques without tools contributed marginally (−0.03 to +2.33 F1), while tool-grounded critiques yielded substantial gains. This was reinforced by Huang et al. (ICLR 2024), who showed definitively that "Large Language Models Cannot Self-Correct Reasoning Yet" without external signals.

---

## What happens when agents don't stop to think

The failure modes of agents that skip reasoning on tool results are well-documented and severe. Research reveals these aren't edge cases—they're the default behavior of unreflective agents.

**Cascading errors from blind tool chaining** represent the most common failure pattern. The NESTFUL benchmark (Basu et al., 2024) tested LLMs on nested API call sequences where one tool's output feeds the next. GPT-4o achieved only **28% full sequence match accuracy**. Individual calls might succeed, but errors compound at each step without intermediate reasoning to catch and correct them. The MAST taxonomy (Cemri et al., NeurIPS 2025), developed from **1,642 annotated execution traces** across seven multi-agent frameworks, catalogued 14 distinct failure modes including: agents continuing past their useful window, retrying indefinitely on API failures, silently swallowing errors, and allowing "a single misinterpreted message early in the workflow to cascade through subsequent steps."

**Tool-calling hallucinations** constitute a distinct and particularly dangerous failure class. Research on internal representations (arXiv:2601.05214) identified structurally plausible but functionally incorrect tool calls, including inappropriate tool selection, malformed parameters, and a phenomenon called **tool bypass behavior**—where the model simulates a tool's output instead of actually calling it. These hallucinations increase with tool count and tool similarity.

**Failure to process tool outputs correctly** is another underappreciated bottleneck. Kate et al. (EACL 2026) isolated the tool response processing task and found that even frontier models max out at **77% accuracy** when extracting information from structured JSON tool responses. Processing approach choice caused performance variations of **3% to 50%**, and models exhibited systematic recency bias when parsing tool outputs. This suggests that even when agents do receive tool results, they may not correctly interpret them without explicit reasoning steps.

Three practical failure patterns from production deployments round out the picture: context window overflow from large unprocessed tool outputs, unclear terminal states causing infinite retry loops, and poor tool documentation leading to incorrect invocations. A "Memory Pointer Pattern" that summarizes tool outputs reduced token usage from **200KB+ to under 100 bytes** per call, while clear terminal states cut tool calls from **14 to 2**.

---

## The empirical case for explicit reasoning steps is overwhelming

Across academic benchmarks and production systems, the performance delta between agents with and without explicit post-observation reasoning is consistently large.

The most controlled evidence comes from ablation studies. Renze and Guven (2024) tested **eight types of self-reflecting agents** versus non-reflecting baselines across GPT-4, Llama 2 70B, and Gemini 1.5 Pro, finding statistically significant improvement (p < 0.001) with **>18% accuracy gains** on problem-solving tasks. Microsoft Research's ARTIST framework (2025) showed that integrated reasoning-and-tool-use training outperformed plain reasoning-only RL by **7.2%** on AMC math problems and **more than doubled accuracy** on the τ-bench multi-turn function calling benchmark versus prompt-based baselines.

Perhaps the most striking practitioner evidence comes from a production engineering report: adding explicit "think before acting" instructions to an agent's system prompt—directing it to explain what it's looking for, why the tool is appropriate, and what it will do with the result before each call—improved tool selection accuracy from **60% to 85%**, a 25 percentage point gain from prompt changes alone.

The 2025–2026 wave of RL-trained tool-reasoning agents provides further evidence. **ReTool** (ICLR 2026) trained a 32B model with reinforcement learning to dynamically interleave code execution within natural language reasoning, achieving **67% on AIME 2024** versus 40% for text-only RL—and surpassing OpenAI's o1-preview by 27.9 percentage points. The model developed emergent **"code self-correction" behaviors** (described as "aha moments"), spontaneously learning to verify and fix its tool outputs. **START** (EMNLP 2025, Alibaba/Qwen) achieved 95.0% on AMC23 and 75.6% on AIME 2024 by inserting strategic hints that trigger tool use for verification during reasoning chains.

| Framework | Benchmark | Without reflection | With reflection | Delta |
|---|---|---|---|---|
| ReAct (2023) | ALFWorld success | ~45% (act-only) | 71% | +26pp |
| Reflexion (2023) | AlfWorld tasks | 71% (ReAct) | 97% | +26pp |
| CRITIC (2024) | QA (F1) | ReAct baseline | +5.1–8.2 F1 | Substantial |
| LATS (2024) | HotPotQA | ReAct baseline | 2× performance | +100% |
| Renze (2024) | MCQA accuracy | Non-reflecting | +18% | +18pp |
| ARTIST (2025) | τ-bench | Prompt-based | 2× accuracy | +100% |
| ReTool (2026) | AIME 2024 | 40% (text-only) | 67% | +27pp |
| Practical (2025) | Tool selection | 60% | 85% | +25pp |

---

## Modern architectures decompose reflection into specialized mechanisms

The field has moved well beyond ReAct's simple thought-action loop. Three architectural trends define the 2025–2026 frontier.

**Multi-agent decomposition of reflection** addresses a fundamental limitation: single-agent self-reflection suffers from confirmation bias and mode collapse. MAR (Multi-Agent Reflexion, 2025) demonstrated this empirically—the same model repeating flawed reasoning across iterations produces diminishing returns. MAR's solution uses diverse persona-based critics and a judge model that synthesizes critiques into unified reflection, improving HumanEval pass@1 by **+6.2 points** over standard Reflexion. The MIRROR framework (IJCAI 2025) introduced dual-layer reflection: **intra-reflection** (each agent assesses its planned action *before* execution) and **inter-reflection** (trajectory adjustment *after* observing results). Removing intra-reflection alone caused a 7% drop in pass rate. Microsoft's ReMA framework goes further, separating a high-level "meta-thinking agent" (strategic oversight) from a low-level "reasoning agent" (execution), with joint rewards training both through multi-agent RL.

**RL-trained reflection policies** replace prompting-based reflection with learned behaviors. ReTool, SCoRe (ICLR 2025), and DPSDP (ICML 2025) all use reinforcement learning to teach models *when and how* to pause, verify, and correct—not just follow a fixed template. SCoRe demonstrated that supervised fine-tuning on correction traces is insufficient due to distribution mismatch; RL training on self-generated data produces genuinely useful correction strategies. This represents a shift from "tell the agent to reflect" to "train the agent to reflect."

**Memory-augmented reflection** stores reflection experiences for reuse across tasks. ReflecTool (ACL 2025) builds long-term tool-wise experience memories for clinical agents, surpassing ReAct, Reflexion, and CRITIC by **3+ points** on an 18-task clinical benchmark. Meta-Policy Reflexion (MPR) consolidates reflections into structured predicate-like memory with hard rule-checking, achieving consistent gains on AlfWorld while enforcing domain safety constraints. This creates a form of meta-learning without weight updates—agents get better at reflecting over time.

---

## What the major AI labs recommend for production agents

Every major AI lab now publishes explicit guidance on reasoning between tool calls, and their recommendations converge remarkably.

**Anthropic's** "Building Effective Agents" (December 2024) identifies five composable workflow patterns, with the **Evaluator-Optimizer** loop—where one LLM generates and another critiques—directly modeling reflection on intermediate results. Their September 2025 engineering post on tool design recommends agents output "reasoning and feedback blocks *before* tool call and response blocks to trigger chain-of-thought behaviors," and their context engineering guide introduces **compaction** (summarizing tool outputs to preserve signal while shedding noise) and **sub-agent architectures** where subagents explore extensively but return condensed summaries of 1,000–2,000 tokens. Anthropic also introduced **interleaved thinking** as a model feature, providing built-in observation-then-think capability.

**OpenAI's** 34-page "Practical Guide to Building Agents" (April 2025) defines a single-agent run loop that explicitly cycles between tool calls and model reasoning until the model either invokes a final-output tool or returns without tool calls. Their guidance emphasizes prompting agents to "break down tasks into smaller steps" and "define clear actions for every step"—structural encouragement for reasoning between actions. OpenAI's Deep Research system (February 2025) uses an o3-powered research agent that operates 5–30 minutes autonomously, "pivoting as needed in reaction to information it encounters" through a plan-act-reflect workflow.

**Google DeepMind's** Gemini 2.5 technical report describes training with RL environments "requiring multi-step actions and tool use," with SWE-bench Verified performance jumping from 34.2% (Gemini 1.5 Pro) to **67.2%** (Gemini 2.5 Pro). Their Deep Research system "formulates a detailed research plan, breaking the problem into sub-tasks" and reasons over fetched information before proceeding.

**LangChain/LangGraph** implements the ReAct pattern as its default agent architecture, "alternating between brief reasoning steps with targeted tool calls and feeding the resulting observations into subsequent decisions." Their 2026 State of AI Agents survey of 1,300+ professionals found **57% have agents in production**, with quality (32%) as the top barrier and **89% implementing observability** including detailed tracing for individual reasoning steps and tool calls.

**Cohere** trained Command R explicitly with an **Action → Observation → Reflection** loop via supervised and preference fine-tuning—baking reflection into the model's behavior rather than relying on prompting alone.

---

## Structured reflection outperforms generic "think about it" prompts

A nuanced finding from recent research: not all reflection is equal. **MOSAIC** (2026) tested a "plan → check → then act" architecture with explicit `<safety_thoughts>` for structured self-reflective reasoning. Simply relying on a generic "think block" dropped harmful-task refusal from **0.87 to 0.59**; structured safety thoughts maintained performance. The implication is clear: agents need *directed* reflection with specific evaluation criteria, not open-ended contemplation.

Similarly, Kate et al. (2026) found that having agents write Python code to parse JSON tool responses outperformed direct answer generation by **3% to 50%** on reasoning-heavy tasks—a form of structured, executable reflection on tool outputs. Including the JSON schema in the prompt improved performance by up to 12%. Andrew Ng identified reflection as one of four foundational agentic design patterns in 2024, noting "I've been delighted by how much it improved my applications' results," while cautioning that planning (the less structured cousin of reflection) remains "a less mature technology" that is "hard to predict."

The cognitive architecture perspective from CoALA (Sumers et al., TMLR 2024) provides the theoretical frame: reflection is an *internal action* operating on working memory, distinct from external tool actions. The most effective agents maintain clear separation between internal reasoning actions (reflecting, retrieving from memory, planning) and external environment actions (calling tools, executing code). Brain-inspired architectures like MAP (Microsoft Research, Nature Communications 2025) decompose planning into specialized modules—conflict monitoring, state prediction, state evaluation, task decomposition—achieving significant improvements with smaller, cost-efficient LLMs and superior cross-task transfer.

---

## Conclusion: reflection is shifting from prompt trick to trained capability

The research trajectory from 2023 to 2026 reveals a clear arc. ReAct demonstrated that reasoning between actions matters. Reflexion and CRITIC showed that reflecting on failures and using tools to verify outputs amplifies the effect. The 2025–2026 wave—ReTool, SCoRe, ARTIST, MAR—is moving reflection from a prompting strategy to a **trained capability**, using reinforcement learning to teach models when to pause, what to verify, and how to recover from errors.

Three insights stand out as genuinely novel. First, the performance ceiling for agents without inter-step reasoning is remarkably low—**28% on nested API sequences**, **~45% on household tasks**—suggesting that unreflective agents are fundamentally unsuitable for complex workflows regardless of the underlying model's capability. Second, multi-agent reflection architectures that decompose critique across diverse personas consistently outperform single-agent self-reflection, because they avoid confirmation bias and mode collapse. Third, the gap between structured and unstructured reflection (MOSAIC's 28 percentage point difference) suggests the field needs to move beyond generic "think step by step" instructions toward domain-specific reflection protocols with explicit evaluation criteria.

The practical consensus across labs is remarkably aligned: start simple, instrument everything, design tools that return concise and meaningful outputs, give agents explicit space to reason about results, and treat context as a finite resource that degrades with size. The agents that work in production are not the ones with the most tools or the longest context windows—they are the ones that stop to think.
