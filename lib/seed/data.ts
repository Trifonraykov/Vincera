import type { Availability, DealPreference, ProductFormat, ProductStage } from "@/lib/db/schema"

/**
 * The demo people and listings `pnpm db:seed` creates (§15 part 1). Fixed, so every run (Docker
 * seeds on every start, e2e before every run) produces the same platform: 10 creators with a
 * verified YouTube audience, 10 builders with GitHub and a portfolio, their ideas and products.
 * Topics overlap on purpose (cooking, fitness, money, languages, photography, productivity, code,
 * travel, games) so matching has something to rank.
 *
 * Emails are `seed-creator-01@example.com` … and `seed-builder-01@example.com` … (CLAUDE.md
 * §19.24 "Seed"); `example.com` never receives mail. Sign in as one through the dev mailbox.
 */

export type SeedCreator = {
  handle: string
  name: string
  niche: string
  bio: string
  topics: string[]
  languages: string[]
  country: string
  /** YouTube subscribers (picks the size tier). */
  followers: number
  avgViews: number
  /** Interactions ÷ views. */
  engagementRate: number
  countries: { country: string; share: number }[]
  /** Share of viewers aged 18–24, 25–34, 35–44, 45+ (rest by the same split). */
  ages: [number, number, number, number]
  femaleShare: number
  videoTitles: string[]
}

export type SeedBuilder = {
  handle: string
  name: string
  bio: string
  skills: string[]
  stack: string[]
  availability: Availability
  dealPreference: DealPreference
  portfolio: {
    title: string
    url: string
    description: string
    format: ProductFormat
    shipped: boolean
  }[]
  github: {
    login: string
    followers: number
    publicRepos: number
    totalStars: number
    totalForks: number
    languages: { name: string; share: number }[]
    contributions: number
  }
}

export type SeedIdea = {
  /** Index into SEED_CREATORS. */
  creator: number
  title: string
  problem: string
  audienceEvidence: string
  format: ProductFormat
  /** Typed like the form ("9", "19.99"); empty for no price. */
  price: string
  topics: string[]
  status: "open" | "draft" | "archived"
}

export type SeedProduct = {
  /** Index into SEED_BUILDERS. */
  builder: number
  title: string
  description: string
  targetUser: string
  stage: ProductStage
  demoUrl: string
  format: ProductFormat
  price: string
  topics: string[]
  preferredSplitBuilderPct: string
  exclusivity: boolean
  status: "seeking" | "draft"
}

export const SEED_CREATORS: SeedCreator[] = [
  {
    handle: "ada_cooks",
    name: "Ada Okafor",
    niche: "Budget cooking for students",
    bio: "Feeding a family of four on £60 a week, one cheap recipe at a time.",
    topics: ["budget cooking", "meal prep", "student recipes"],
    languages: ["en"],
    country: "GB",
    followers: 48_200,
    avgViews: 21_500,
    engagementRate: 0.061,
    countries: [
      { country: "GB", share: 0.45 },
      { country: "US", share: 0.2 },
      { country: "NG", share: 0.1 },
      { country: "IE", share: 0.05 },
    ],
    ages: [0.38, 0.34, 0.16, 0.12],
    femaleShare: 0.62,
    videoTitles: [
      "£25 weekly meal prep for students #mealprep",
      "5 budget recipes with one bag of rice",
      "Cheap meal prep: lentil curry for the whole week",
      "What I eat on a £3 a day budget #budgetcooking",
    ],
  },
  {
    handle: "fitwithmarco",
    name: "Marco Rossi",
    niche: "Home strength training",
    bio: "No gym, no excuses. Bodyweight and dumbbell programs you can do in a small flat.",
    topics: ["home workouts", "strength training", "fitness"],
    languages: ["en", "it"],
    country: "IT",
    followers: 215_000,
    avgViews: 64_000,
    engagementRate: 0.048,
    countries: [
      { country: "IT", share: 0.4 },
      { country: "US", share: 0.2 },
      { country: "GB", share: 0.1 },
      { country: "DE", share: 0.06 },
    ],
    ages: [0.31, 0.4, 0.19, 0.1],
    femaleShare: 0.28,
    videoTitles: [
      "12 week home strength program, week 1 #homeworkout",
      "Dumbbell only full body workout (30 min)",
      "How to track progressive overload at home",
      "Beginner push up progression #strengthtraining",
    ],
  },
  {
    handle: "moneywithmaya",
    name: "Maya Patel",
    niche: "Personal finance for students and first jobbers",
    bio: "Budgeting, saving and your first investments, explained without the jargon.",
    topics: ["personal finance", "budgeting", "investing basics"],
    languages: ["en"],
    country: "US",
    followers: 640_000,
    avgViews: 180_000,
    engagementRate: 0.039,
    countries: [
      { country: "US", share: 0.55 },
      { country: "CA", share: 0.1 },
      { country: "GB", share: 0.1 },
      { country: "IN", share: 0.08 },
    ],
    ages: [0.42, 0.36, 0.14, 0.08],
    femaleShare: 0.57,
    videoTitles: [
      "The only budgeting spreadsheet you need #budgeting",
      "How I paid off $12k of student loans",
      "Investing basics for your first paycheck",
      "50/30/20 budget explained in 5 minutes",
    ],
  },
  {
    handle: "lena_lernt",
    name: "Lena Vogel",
    niche: "Learning German, the friendly way",
    bio: "Short German lessons and study tips for busy adults.",
    topics: ["language learning", "german", "study tips"],
    languages: ["de", "en"],
    country: "DE",
    followers: 8_400,
    avgViews: 3_100,
    engagementRate: 0.083,
    countries: [
      { country: "DE", share: 0.5 },
      { country: "AT", share: 0.15 },
      { country: "CH", share: 0.1 },
      { country: "US", share: 0.06 },
    ],
    ages: [0.29, 0.37, 0.21, 0.13],
    femaleShare: 0.66,
    videoTitles: [
      "100 German words you use every day #languagelearning",
      "Spaced repetition for German vocab",
      "Der, die, das: a trick that works",
      "My study routine for B1 German",
    ],
  },
  {
    handle: "pixel_tomas",
    name: "Tomás García",
    niche: "Travel photography and editing",
    bio: "Lightroom edits and photo walks from Spain and Latin America.",
    topics: ["photography", "photo editing", "lightroom"],
    languages: ["es", "en"],
    country: "ES",
    followers: 92_000,
    avgViews: 27_000,
    engagementRate: 0.052,
    countries: [
      { country: "ES", share: 0.35 },
      { country: "MX", share: 0.2 },
      { country: "AR", share: 0.1 },
      { country: "US", share: 0.1 },
    ],
    ages: [0.27, 0.41, 0.2, 0.12],
    femaleShare: 0.35,
    videoTitles: [
      "Golden hour Lightroom edit, start to finish #lightroom",
      "My 5 favourite presets for street photography",
      "Editing travel photos on your phone",
      "Photo walk in Seville #photography",
    ],
  },
  {
    handle: "notion_nora",
    name: "Nora Lind",
    niche: "Productivity systems in Notion",
    bio: "Study planners, habit trackers and second brains, built in Notion.",
    topics: ["productivity", "notion templates", "study tips"],
    languages: ["en", "sv"],
    country: "SE",
    followers: 156_000,
    avgViews: 41_000,
    engagementRate: 0.057,
    countries: [
      { country: "US", share: 0.3 },
      { country: "SE", share: 0.15 },
      { country: "GB", share: 0.1 },
      { country: "DE", share: 0.08 },
    ],
    ages: [0.47, 0.33, 0.12, 0.08],
    femaleShare: 0.71,
    videoTitles: [
      "My Notion study planner tour #notion",
      "Build a habit tracker in Notion in 10 minutes",
      "How I plan my semester (Notion template)",
      "Second brain setup for students #productivity",
    ],
  },
  {
    handle: "dadcodes",
    name: "Sam Chen",
    niche: "Learning to code after 30",
    bio: "Former accountant, now a developer. Helping career changers write their first app.",
    topics: ["learn to code", "javascript", "career change"],
    languages: ["en"],
    country: "CA",
    followers: 31_000,
    avgViews: 9_800,
    engagementRate: 0.067,
    countries: [
      { country: "US", share: 0.35 },
      { country: "CA", share: 0.2 },
      { country: "IN", share: 0.15 },
      { country: "GB", share: 0.08 },
    ],
    ages: [0.18, 0.39, 0.29, 0.14],
    femaleShare: 0.3,
    videoTitles: [
      "JavaScript exercises for absolute beginners #javascript",
      "I changed careers at 34: what I wish I knew",
      "Build your first web app in a weekend",
      "How to practise coding every day #learntocode",
    ],
  },
  {
    handle: "wanderjuli",
    name: "Julia Santos",
    niche: "Budget backpacking",
    bio: "Six continents on a shoestring. Itineraries, budgets and honest hostel reviews.",
    topics: ["budget travel", "travel planning", "backpacking"],
    languages: ["pt", "en"],
    country: "BR",
    followers: 74_000,
    avgViews: 19_000,
    engagementRate: 0.049,
    countries: [
      { country: "BR", share: 0.5 },
      { country: "PT", share: 0.15 },
      { country: "US", share: 0.1 },
      { country: "AR", share: 0.05 },
    ],
    ages: [0.36, 0.38, 0.17, 0.09],
    femaleShare: 0.58,
    videoTitles: [
      "Backpacking South America on $30 a day #budgettravel",
      "How I plan a 3 week trip in one evening",
      "Cheapest way to travel Europe by train",
      "My travel budget spreadsheet #travelplanning",
    ],
  },
  {
    handle: "plantbased_pri",
    name: "Priya Nair",
    niche: "Plant-based meal prep",
    bio: "High-protein vegan meal prep that costs less than takeaway.",
    topics: ["meal prep", "plant-based", "healthy eating"],
    languages: ["en"],
    country: "IN",
    followers: 5_600,
    avgViews: 2_400,
    engagementRate: 0.091,
    countries: [
      { country: "IN", share: 0.4 },
      { country: "US", share: 0.2 },
      { country: "GB", share: 0.1 },
      { country: "AE", share: 0.06 },
    ],
    ages: [0.33, 0.41, 0.17, 0.09],
    femaleShare: 0.69,
    videoTitles: [
      "Vegan meal prep for the week under ₹1500 #mealprep",
      "High protein plant-based lunches",
      "My grocery list for plant-based meal prep",
      "Tofu three ways #plantbased",
    ],
  },
  {
    handle: "retro_rik",
    name: "Rik de Vries",
    niche: "Indie games and pixel art",
    bio: "Reviews of small games and devlogs from my own pixel art projects.",
    topics: ["indie games", "game dev", "pixel art"],
    languages: ["nl", "en"],
    country: "NL",
    followers: 380_000,
    avgViews: 95_000,
    engagementRate: 0.044,
    countries: [
      { country: "US", share: 0.3 },
      { country: "NL", share: 0.15 },
      { country: "DE", share: 0.1 },
      { country: "GB", share: 0.1 },
    ],
    ages: [0.44, 0.35, 0.14, 0.07],
    femaleShare: 0.22,
    videoTitles: [
      "Top 10 indie games of the year #indiegames",
      "Pixel art palettes that just work",
      "Devlog: my first game in Godot #gamedev",
      "How to animate a pixel art character",
    ],
  },
]

export const SEED_BUILDERS: SeedBuilder[] = [
  {
    handle: "octo_ines",
    name: "Inês Costa",
    bio: "Full-stack developer building small web apps for food and home budgets.",
    skills: ["web apps", "meal planning", "payments"],
    stack: ["typescript", "react", "next.js", "postgres"],
    availability: "open",
    dealPreference: "split",
    portfolio: [
      {
        title: "Pantry Planner",
        url: "https://example.com/pantry-planner",
        description: "Plans a week of meals from what is already in the cupboard.",
        format: "app",
        shipped: true,
      },
      {
        title: "Recipe Scaler",
        url: "https://example.com/recipe-scaler",
        description: "Scales recipes to any number of portions and converts units.",
        format: "tool",
        shipped: true,
      },
    ],
    github: {
      login: "octo-ines",
      followers: 840,
      publicRepos: 37,
      totalStars: 2_150,
      totalForks: 190,
      languages: [
        { name: "TypeScript", share: 0.71 },
        { name: "CSS", share: 0.14 },
        { name: "PLpgSQL", share: 0.08 },
      ],
      contributions: 1_420,
    },
  },
  {
    handle: "kofi_builds",
    name: "Kofi Mensah",
    bio: "Mobile developer. I build fitness and habit apps people actually keep using.",
    skills: ["fitness tracking", "mobile apps", "home workouts"],
    stack: ["react native", "typescript", "firebase"],
    availability: "open",
    dealPreference: "either",
    portfolio: [
      {
        title: "Rep Counter",
        url: "https://example.com/rep-counter",
        description: "Counts reps with the phone camera and logs every workout.",
        format: "app",
        shipped: true,
      },
    ],
    github: {
      login: "kofi-builds",
      followers: 310,
      publicRepos: 22,
      totalStars: 640,
      totalForks: 51,
      languages: [
        { name: "TypeScript", share: 0.64 },
        { name: "Kotlin", share: 0.18 },
        { name: "Swift", share: 0.12 },
      ],
      contributions: 960,
    },
  },
  {
    handle: "ledger_lars",
    name: "Lars Eriksen",
    bio: "Data person. Spreadsheets, budgeting tools and dashboards that make money boring again.",
    skills: ["personal finance", "spreadsheets", "data visualisation", "budgeting"],
    stack: ["python", "django", "postgres", "google sheets"],
    availability: "limited",
    dealPreference: "split",
    portfolio: [
      {
        title: "Budget Buddy",
        url: "https://example.com/budget-buddy",
        description: "A zero-based budgeting spreadsheet with monthly reports.",
        format: "template",
        shipped: true,
      },
      {
        title: "Split Calc",
        url: "https://example.com/split-calc",
        description: "Splits shared bills fairly between housemates.",
        format: "tool",
        shipped: false,
      },
    ],
    github: {
      login: "ledger-lars",
      followers: 120,
      publicRepos: 18,
      totalStars: 380,
      totalForks: 40,
      languages: [
        { name: "Python", share: 0.78 },
        { name: "HTML", share: 0.12 },
        { name: "JavaScript", share: 0.07 },
      ],
      contributions: 610,
    },
  },
  {
    handle: "anya_ai",
    name: "Anya Petrova",
    bio: "I build AI study tools: flashcards, tutors and quiz generators.",
    skills: ["ai utilities", "language learning", "llm apps"],
    stack: ["python", "fastapi", "typescript"],
    availability: "open",
    dealPreference: "split",
    portfolio: [
      {
        title: "Flashcard Forge",
        url: "https://example.com/flashcard-forge",
        description: "Turns any text into spaced-repetition flashcards.",
        format: "ai_utility",
        shipped: true,
      },
    ],
    github: {
      login: "anya-ai",
      followers: 1_900,
      publicRepos: 41,
      totalStars: 5_300,
      totalForks: 420,
      languages: [
        { name: "Python", share: 0.66 },
        { name: "TypeScript", share: 0.27 },
      ],
      contributions: 2_050,
    },
  },
  {
    handle: "devon_tools",
    name: "Devon Clarke",
    bio: "Photographer turned developer. Browser tools for editing and organising photos.",
    skills: ["photo editing", "browser extensions", "image processing"],
    stack: ["typescript", "rust", "webassembly"],
    availability: "open",
    dealPreference: "either",
    portfolio: [
      {
        title: "Preset Packer",
        url: "https://example.com/preset-packer",
        description: "Bundles Lightroom presets into a store-ready download.",
        format: "tool",
        shipped: true,
      },
    ],
    github: {
      login: "devon-tools",
      followers: 260,
      publicRepos: 15,
      totalStars: 910,
      totalForks: 66,
      languages: [
        { name: "Rust", share: 0.52 },
        { name: "TypeScript", share: 0.41 },
      ],
      contributions: 730,
    },
  },
  {
    handle: "notionsmith",
    name: "Hana Sato",
    bio: "Notion consultant. Templates and automations for students and small teams.",
    skills: ["notion templates", "productivity", "automation", "study tips"],
    stack: ["notion api", "javascript", "zapier"],
    availability: "open",
    dealPreference: "split",
    portfolio: [
      {
        title: "Study OS",
        url: "https://example.com/study-os",
        description: "A Notion workspace for a whole degree: courses, deadlines and notes.",
        format: "template",
        shipped: true,
      },
    ],
    github: {
      login: "notionsmith",
      followers: 95,
      publicRepos: 9,
      totalStars: 140,
      totalForks: 12,
      languages: [{ name: "JavaScript", share: 0.88 }],
      contributions: 320,
    },
  },
  {
    handle: "course_cam",
    name: "Cam Rivera",
    bio: "I build course platforms and interactive coding exercises.",
    skills: ["course platforms", "learn to code", "javascript", "video"],
    stack: ["ruby on rails", "postgres", "stripe"],
    availability: "limited",
    dealPreference: "fixed",
    portfolio: [
      {
        title: "Lesson Gate",
        url: "https://example.com/lesson-gate",
        description: "Sells and gates video lessons with built-in exercises.",
        format: "course_tool",
        shipped: true,
      },
    ],
    github: {
      login: "course-cam",
      followers: 430,
      publicRepos: 28,
      totalStars: 1_200,
      totalForks: 150,
      languages: [
        { name: "Ruby", share: 0.61 },
        { name: "JavaScript", share: 0.3 },
      ],
      contributions: 880,
    },
  },
  {
    handle: "trip_theo",
    name: "Theo Martin",
    bio: "Maps nerd. Trip planners and budget tools for travellers.",
    skills: ["travel planning", "maps", "budget travel"],
    stack: ["vue", "node.js", "mapbox"],
    availability: "open",
    dealPreference: "either",
    portfolio: [
      {
        title: "Route Saver",
        url: "https://example.com/route-saver",
        description: "Saves offline routes for multi-city trips.",
        format: "app",
        shipped: false,
      },
    ],
    github: {
      login: "trip-theo",
      followers: 75,
      publicRepos: 12,
      totalStars: 210,
      totalForks: 18,
      languages: [
        { name: "Vue", share: 0.48 },
        { name: "JavaScript", share: 0.44 },
      ],
      contributions: 410,
    },
  },
  {
    handle: "pixel_quinn",
    name: "Quinn Harper",
    bio: "Game developer making small tools for pixel artists.",
    skills: ["game dev", "pixel art", "indie games"],
    stack: ["godot", "c#", "aseprite"],
    availability: "open",
    dealPreference: "split",
    portfolio: [
      {
        title: "Sprite Sheet Slicer",
        url: "https://example.com/sprite-slicer",
        description: "Slices and names sprite sheets for any engine.",
        format: "tool",
        shipped: true,
      },
    ],
    github: {
      login: "pixel-quinn",
      followers: 670,
      publicRepos: 31,
      totalStars: 2_900,
      totalForks: 230,
      languages: [
        { name: "GDScript", share: 0.55 },
        { name: "C#", share: 0.38 },
      ],
      contributions: 1_100,
    },
  },
  {
    handle: "cora_weiss",
    name: "Cora Weiss",
    bio: "Freelance developer focused on invoicing and payments. Fully booked this quarter.",
    skills: ["web apps", "payments", "invoicing"],
    stack: ["go", "react"],
    availability: "closed",
    dealPreference: "fixed",
    portfolio: [
      {
        title: "Invoice Kit",
        url: "https://example.com/invoice-kit",
        description: "Invoices and reminders for freelancers.",
        format: "tool",
        shipped: true,
      },
    ],
    github: {
      login: "cora-weiss",
      followers: 150,
      publicRepos: 20,
      totalStars: 470,
      totalForks: 35,
      languages: [
        { name: "Go", share: 0.7 },
        { name: "TypeScript", share: 0.25 },
      ],
      contributions: 540,
    },
  },
]

export const SEED_IDEAS: SeedIdea[] = [
  {
    creator: 0,
    title: "Weekly £25 meal planner",
    problem:
      "My viewers want to eat well on a tiny budget but lose time planning. A planner that builds a week of cheap meals and one shopping list would save them hours.",
    audienceEvidence: "Every meal prep video gets dozens of comments asking for a printable plan.",
    format: "app",
    price: "9",
    topics: ["budget cooking", "meal prep", "grocery lists"],
    status: "open",
  },
  {
    creator: 0,
    title: "Leftover remix recipe finder",
    problem: "Turn what is left in the fridge into a recipe.",
    audienceEvidence: "",
    format: "tool",
    price: "5",
    topics: ["budget cooking", "leftovers"],
    status: "draft",
  },
  {
    creator: 1,
    title: "12-week home strength tracker",
    problem:
      "People start my programs but lose track of sets and weights. A simple tracker with my 12-week plan built in would keep them going.",
    audienceEvidence: '"Is there an app for this program?" is the top comment on the series.',
    format: "app",
    price: "19",
    topics: ["home workouts", "strength training", "fitness tracking"],
    status: "open",
  },
  {
    creator: 2,
    title: "Student budget spreadsheet kit",
    problem:
      "Students want a budget that works with irregular income from part-time jobs. A ready-made spreadsheet kit with monthly reports would get them started in minutes.",
    audienceEvidence: "My budgeting spreadsheet video has 1,200 comments asking for the file.",
    format: "template",
    price: "15",
    topics: ["budgeting", "personal finance", "spreadsheets"],
    status: "open",
  },
  {
    creator: 2,
    title: "First paycheck investing calculator",
    problem: "Show what small monthly investments grow into.",
    audienceEvidence: "",
    format: "tool",
    price: "0",
    topics: ["investing basics"],
    status: "archived",
  },
  {
    creator: 3,
    title: "German vocab spaced-repetition deck",
    problem:
      "My learners forget new words within days. A spaced-repetition deck generated from each lesson's vocabulary would make it stick.",
    audienceEvidence: "Viewers keep asking for flashcards that match the lessons.",
    format: "ai_utility",
    price: "7",
    topics: ["language learning", "german", "flashcards"],
    status: "open",
  },
  {
    creator: 4,
    title: "Golden hour Lightroom preset pack",
    problem:
      "Viewers love my golden hour edits but struggle to reproduce them. A preset pack with a short guide would do it in one click.",
    audienceEvidence: 'Every edit video gets "please share the preset" comments.',
    format: "template",
    price: "12",
    topics: ["lightroom", "photo editing", "presets"],
    status: "open",
  },
  {
    creator: 5,
    title: "Notion semester planner",
    problem:
      "Students need one place for courses, deadlines and study sessions. A Notion template with a weekly review would keep a whole semester on track.",
    audienceEvidence: "My planner tour is my most-viewed video and the comments ask for a copy.",
    format: "template",
    price: "10",
    topics: ["notion templates", "study tips", "productivity"],
    status: "open",
  },
  {
    creator: 6,
    title: "Interactive JavaScript exercises for career changers",
    problem:
      "Career changers learn by doing but get stuck alone. Short in-browser exercises with hints, matched to my videos, would keep them practising.",
    audienceEvidence: "Viewers ask where to practise after every beginner video.",
    format: "course_tool",
    price: "29",
    topics: ["learn to code", "javascript", "career change"],
    status: "open",
  },
  {
    creator: 7,
    title: "Backpacking trip budget planner",
    problem:
      "Planning a multi-country trip on a budget takes evenings of spreadsheets. A planner that splits a budget per day and per country would make it quick.",
    audienceEvidence: "My travel budget spreadsheet video is full of requests for the template.",
    format: "app",
    price: "8",
    topics: ["budget travel", "travel planning", "backpacking"],
    status: "open",
  },
  {
    creator: 8,
    title: "Plant-based grocery list generator",
    problem:
      "Viewers want my weekly plant-based meal prep without writing the list themselves. Pick the recipes, get one grocery list by aisle.",
    audienceEvidence: '"Can you share the shopping list?" under every video.',
    format: "ai_utility",
    price: "6",
    topics: ["meal prep", "plant-based", "grocery lists"],
    status: "open",
  },
  {
    creator: 9,
    title: "Pixel art palette generator",
    problem:
      "Artists in my community want palettes that look good together at low resolution. A generator with presets from my favourite games would help them start.",
    audienceEvidence: "My palette video comments are full of palette requests.",
    format: "tool",
    price: "4",
    topics: ["pixel art", "game dev", "indie games"],
    status: "open",
  },
]

export const SEED_PRODUCTS: SeedProduct[] = [
  {
    builder: 0,
    title: "Pantry Planner",
    description:
      "Plans a week of meals from what is already in your cupboard, with a **single shopping list** for the rest. Built for tight food budgets.",
    targetUser: "Students and families cooking on a budget",
    stage: "beta",
    demoUrl: "https://example.com/pantry-planner",
    format: "app",
    price: "9",
    topics: ["meal prep", "budget cooking", "grocery lists"],
    preferredSplitBuilderPct: "50",
    exclusivity: false,
    status: "seeking",
  },
  {
    builder: 1,
    title: "Rep Counter Pro",
    description:
      "Counts reps with the camera, logs every set and builds programs you can follow at home.",
    targetUser: "People training at home without a coach",
    stage: "live",
    demoUrl: "https://example.com/rep-counter",
    format: "app",
    price: "12",
    topics: ["fitness tracking", "home workouts", "strength training"],
    preferredSplitBuilderPct: "60",
    exclusivity: false,
    status: "seeking",
  },
  {
    builder: 2,
    title: "Budget Buddy Sheets",
    description: "A zero-based budget in Google Sheets with monthly reports and savings goals.",
    targetUser: "Students and first jobbers starting a budget",
    stage: "live",
    demoUrl: "https://example.com/budget-buddy",
    format: "template",
    price: "15",
    topics: ["budgeting", "personal finance", "spreadsheets"],
    preferredSplitBuilderPct: "40",
    exclusivity: true,
    status: "seeking",
  },
  {
    builder: 3,
    title: "Flashcard Forge",
    description:
      "Paste a lesson, get spaced-repetition flashcards with example sentences and audio.",
    targetUser: "Language learners who study a little every day",
    stage: "beta",
    demoUrl: "https://example.com/flashcard-forge",
    format: "ai_utility",
    price: "7",
    topics: ["language learning", "flashcards", "study tips"],
    preferredSplitBuilderPct: "50",
    exclusivity: false,
    status: "seeking",
  },
  {
    builder: 4,
    title: "Preset Packer",
    description:
      "Bundles Lightroom presets with before/after previews into a store-ready download.",
    targetUser: "Photographers who sell their editing style",
    stage: "prototype",
    demoUrl: "https://example.com/preset-packer",
    format: "tool",
    price: "10",
    topics: ["lightroom", "photo editing", "presets"],
    preferredSplitBuilderPct: "50",
    exclusivity: false,
    status: "seeking",
  },
  {
    builder: 5,
    title: "Study OS for Notion",
    description:
      "A Notion workspace for a whole degree: courses, deadlines, notes and weekly reviews.",
    targetUser: "University students who live in Notion",
    stage: "live",
    demoUrl: "https://example.com/study-os",
    format: "template",
    price: "10",
    topics: ["notion templates", "productivity", "study tips"],
    preferredSplitBuilderPct: "50",
    exclusivity: false,
    status: "seeking",
  },
  {
    builder: 6,
    title: "Lesson Gate",
    description: "Sell video lessons with in-browser coding exercises and progress tracking.",
    targetUser: "Educators teaching beginners to code",
    stage: "beta",
    demoUrl: "https://example.com/lesson-gate",
    format: "course_tool",
    price: "29",
    topics: ["learn to code", "online courses", "javascript"],
    preferredSplitBuilderPct: "55",
    exclusivity: false,
    status: "seeking",
  },
  {
    builder: 7,
    title: "Trip Budget Splitter",
    description: "Splits a travel budget per day and per country, and tracks spending offline.",
    targetUser: "Backpackers on long trips",
    stage: "prototype",
    demoUrl: "https://example.com/trip-budget",
    format: "tool",
    price: "4",
    topics: ["budget travel", "travel planning", "backpacking"],
    preferredSplitBuilderPct: "50",
    exclusivity: false,
    status: "seeking",
  },
  {
    builder: 7,
    title: "Route Saver",
    description: "Offline routes for multi-city trips.",
    targetUser: "Travellers with patchy data",
    stage: "idea",
    demoUrl: "",
    format: "app",
    price: "8",
    topics: ["travel planning", "maps"],
    preferredSplitBuilderPct: "",
    exclusivity: false,
    status: "draft",
  },
  {
    builder: 8,
    title: "Sprite Sheet Slicer",
    description: "Slices, names and exports sprite sheets for Godot, Unity and GameMaker.",
    targetUser: "Pixel artists and indie game developers",
    stage: "live",
    demoUrl: "https://example.com/sprite-slicer",
    format: "tool",
    price: "5",
    topics: ["pixel art", "game dev", "indie games"],
    preferredSplitBuilderPct: "50",
    exclusivity: false,
    status: "seeking",
  },
  {
    builder: 9,
    title: "Invoice Kit",
    description: "Invoices, reminders and late fees for freelancers.",
    targetUser: "Freelancers who hate chasing payments",
    stage: "live",
    demoUrl: "https://example.com/invoice-kit",
    format: "tool",
    price: "19",
    topics: ["invoicing", "freelancers", "payments"],
    preferredSplitBuilderPct: "70",
    exclusivity: false,
    status: "seeking",
  },
]

export function seedCreatorEmail(index: number): string {
  return `seed-creator-${String(index + 1).padStart(2, "0")}@example.com`
}

export function seedBuilderEmail(index: number): string {
  return `seed-builder-${String(index + 1).padStart(2, "0")}@example.com`
}
