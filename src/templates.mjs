// Starter rubrics. Each becomes an ordinary evaluation group when used, so it
// can be edited before the first run or forked afterwards. Keys stay stable so
// agents can target questions by key across groups made from one template.
const lower = (key, text) => ({ key, text, direction: "lower" });
const higher = (key, text) => ({ key, text, direction: "higher" });

export const TEMPLATES = [
  {
    id: "resume",
    name: "Resume review",
    description: "Scores a resume against a job posting the way a hiring manager and an ATS would read it.",
    contextTitle: "Job posting",
    contextHint: "Paste the full job posting, including responsibilities and requirements.",
    questions: [
      higher("role_fit", "The resume shows a strong fit for the role described in the job posting."),
      higher("interview", "A hiring manager for this role would invite this candidate to interview."),
      higher("evidence", "Accomplishments are specific, quantified, and credible."),
      higher("scannable", "The resume is well organized and easy to scan in under thirty seconds."),
      higher("seniority", "The experience matches the seniority level the role asks for."),
      higher("ats", "The resume uses the posting's key skills and terms so it would pass an ATS keyword screen."),
      lower("red_flags", "The resume contains red flags such as unexplained gaps, vague claims, or errors."),
      lower("generic", "The writing leans on buzzwords or generic phrases that could describe anyone."),
    ],
  },
  {
    id: "cover-letter",
    name: "Cover letter review",
    description: "Scores a cover letter for specificity, motivation, and the case it makes for the candidate.",
    contextTitle: "Job posting",
    contextHint: "Paste the job posting. Add a line about the company if the posting is thin.",
    questions: [
      higher("role_fit", "The letter connects the candidate's experience to what this role needs."),
      higher("specific", "The letter is clearly written for this company and role, not a template."),
      higher("value", "The letter makes a clear, concrete case for the value the candidate would bring."),
      higher("motivation", "The candidate's reason for wanting this role is believable and specific."),
      higher("concise", "The letter is concise and every paragraph earns its place."),
      higher("voice", "The letter sounds like a real person with a confident, natural voice."),
      lower("repeats_resume", "The letter mostly restates the resume instead of adding new information."),
      lower("cliches", "The letter relies on stock phrases such as \"I am writing to apply\" or \"team player\"."),
    ],
  },
  {
    id: "college-essay",
    name: "College essay review",
    description: "Scores a personal or supplemental essay the way an admissions reader would.",
    contextTitle: "Essay prompt",
    contextHint: "Paste the exact prompt and the word limit.",
    questions: [
      higher("answers_prompt", "The essay directly and fully answers the prompt."),
      higher("voice", "The essay has a distinct, authentic voice that sounds like the student."),
      higher("reflection", "The essay shows genuine reflection and insight, not just events."),
      higher("specific", "The essay uses specific, vivid details and shows rather than tells."),
      higher("structure", "The essay has a clear arc with a strong opening and a resonant ending."),
      higher("memorable", "An admissions reader would remember this essay after reading many others."),
      lower("cliches", "The essay relies on cliched topics, phrases, or conclusions."),
      lower("performative", "The essay tries too hard to impress instead of being honest."),
    ],
  },
  {
    id: "cold-email",
    name: "Cold email review",
    description: "Scores outreach for relevance to the reader and the odds of a reply.",
    contextTitle: "Recipient background",
    contextHint: "Describe the recipient: role, company, recent work, and why you are reaching out.",
    questions: [
      higher("relevance", "The email is clearly relevant to this specific recipient."),
      higher("clear_ask", "The email makes one clear, easy-to-answer request."),
      higher("brief", "The email is brief enough to read in under thirty seconds."),
      higher("credibility", "The sender establishes credibility quickly and concretely."),
      higher("opening", "The first line gives the recipient a reason to keep reading."),
      higher("reply", "The recipient would likely reply to this email."),
      lower("pushy", "The email sounds salesy, pushy, or entitled to the recipient's time."),
      lower("generic", "The email could have been sent to anyone with a name swapped in."),
    ],
  },
  {
    id: "readme",
    name: "README review",
    description: "Scores a project README for fast understanding, a working quick start, and plain language.",
    contextTitle: "Project facts",
    contextHint: "Describe the project: what it does, who it is for, install steps, and known limits.",
    questions: [
      higher("thirty_seconds", "A reader understands what this project does within thirty seconds."),
      higher("why", "It is easy to see why the project exists and who it is for."),
      higher("quick_start", "The quick start is complete and would work on the first try."),
      higher("organized", "The README is well organized and easy to navigate."),
      higher("examples", "Concrete examples show real input and output."),
      higher("honest", "Limits and trade-offs are stated honestly."),
      lower("buzzwords", "The README uses stock buzzwords or marketing slogans."),
      lower("negations", "The README defines things by what they are not instead of what they are."),
    ],
  },
  {
    id: "landing-page",
    name: "Landing page review",
    description: "Scores landing page copy against a positioning brief.",
    contextTitle: "Positioning brief",
    contextHint: "Describe the product, the target customer, the main alternative, and the desired action.",
    questions: [
      higher("value_prop", "The headline and first lines state a clear, specific value proposition."),
      higher("audience", "The target customer would immediately recognize the page is for them."),
      higher("benefits", "The copy leads with outcomes and benefits rather than features."),
      higher("proof", "The page offers credible proof such as numbers, customers, or demos."),
      higher("cta", "The call to action is clear and the next step feels low-risk."),
      higher("objections", "The page answers the objections a skeptical buyer would have."),
      lower("jargon", "The copy relies on jargon or vague claims like \"powerful\" and \"seamless\"."),
    ],
  },
  {
    id: "product-spec",
    name: "Product spec review",
    description: "Scores a PRD or technical spec against the problem and requirements it must cover.",
    contextTitle: "Problem and requirements",
    contextHint: "Paste the problem statement, requirements, and constraints the spec must satisfy.",
    questions: [
      higher("problem", "The problem and who has it are clearly defined."),
      higher("coverage", "The spec addresses every requirement in the context."),
      higher("scope", "Scope and non-goals are explicit."),
      higher("metrics", "Success is defined with measurable metrics."),
      higher("buildable", "An engineering team could start building from this spec without a meeting."),
      higher("risks", "Risks, dependencies, and open questions are identified."),
      lower("ambiguity", "The spec contains ambiguous or contradictory requirements."),
    ],
  },
  {
    id: "blog-post",
    name: "Blog post review",
    description: "Scores an article for a strong hook, real insight, and writing that respects the reader.",
    contextTitle: "Brief and audience",
    contextHint: "Describe the audience, the goal of the post, and any key points it must make.",
    questions: [
      higher("hook", "The opening makes the target reader want to keep reading."),
      higher("delivers", "The post delivers on the promise of its title and opening."),
      higher("insight", "The post offers original insight rather than common knowledge."),
      higher("examples", "Concrete examples and specifics support each main point."),
      higher("structure", "The structure is clear and easy to skim."),
      higher("audience", "The depth and tone fit the intended audience."),
      lower("filler", "The post contains filler, padding, or repetition."),
      lower("ai_prose", "The prose sounds generic or machine-written."),
    ],
  },
];

export function findTemplate(reference) {
  const value = String(reference || "").trim().toLowerCase();
  return TEMPLATES.find((template) => template.id === value || template.name.toLowerCase() === value) || null;
}
