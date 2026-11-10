// The made-up team the seed fills Ember with: Fernwood, a small software company in the week of a
// launch. Their pictures are in files/, whose README says where each one came from.

/** A bot: its name, and the file in files/ that's its picture, or none for Ember's stock bot picture. */
export interface Bot {
  name: string;
  avatar?: string;
}

export interface Person {
  name: string;
  emailAddress: string;
  bio: string;
  /** The file in files/ that's their picture, or none for their initials. */
  avatar?: string;
}

export const WORKSPACE = { name: "Fernwood", tagline: "Calm software, made together" };

/** The people, the first of whom sets Ember up and administers it. */
export const PEOPLE = {
  maya: { name: "Maya Chen", emailAddress: "maya@example.com", bio: "Product lead. Ask me about the roadmap.", avatar: "maya.png" },
  sam: { name: "Sam Rivera", emailAddress: "sam@example.com", bio: "Backend and infrastructure. Probably deploying something.", avatar: "sam.png" },
  priya: { name: "Priya Patel", emailAddress: "priya@example.com", bio: "Design systems, type and the occasional illustration.", avatar: "priya.png" },
  leo: { name: "Leo Park", emailAddress: "leo@example.com", bio: "Front end. Will trade code reviews for coffee.", avatar: "leo.png" },
  jordan: { name: "Jordan Lee", emailAddress: "jordan@example.com", bio: "Marketing and community." },
  amara: { name: "Amara Okafor", emailAddress: "amara@example.com", bio: "Support lead, here for the customers.", avatar: "amara.png" },
  tomas: { name: "Tomás García", emailAddress: "tomas@example.com", bio: "QA and releases. Hiking most weekends.", avatar: "tomas.jpg" },
} satisfies Record<string, Person>;

export type PersonName = keyof typeof PEOPLE;

/** The bots, one with a picture of its own and one with Ember's stock bot picture. */
export const BOTS = {
  deploys: { name: "Deploy Bot", avatar: "deploy-bot.png" },
  uptime: { name: "Uptime" },
} satisfies Record<string, Bot>;

export type BotName = keyof typeof BOTS;
