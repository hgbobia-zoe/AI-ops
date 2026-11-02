// Role SOPs a new hire reads and signs during onboarding. The text lives here (versioned) so the signed
// record says exactly which version the person acknowledged. Bump `version` whenever the wording changes.

export interface SopSection {
  heading: string;
  intro?: string;
  items?: { title?: string; text: string; sub?: string[] }[];
}

export interface Sop {
  id: string;
  title: string;
  version: string;
  objective: string;
  sections: SopSection[];
  signOff: string;
}

const SALES_ASSOCIATE: Sop = {
  id: "sales_associate",
  title: "Sales Associate Onboarding SOP",
  version: "2026-11-02",
  objective:
    "Give the new Sales Associate the tools, resources, and knowledge to engage customers, answer inquiries, and make sure every customer is satisfied.",
  sections: [
    {
      heading: "1. Welcome and overview",
      intro:
        "Welcome to Zoe Event Rentals! Our mission is to provide high quality, unique event rental services so customers have exceptional experiences. You are the face of our business: you resolve issues, give information, and guide clients through booking.",
      items: [{ title: "Company values", text: "Customer centric service, professionalism, adaptability, attention to detail." }],
    },
    {
      heading: "2. Tools and platform access",
      intro: "You will receive a login for each of these.",
      items: [
        { title: "Yelp for Business", text: "Manage reviews, answer inquiries, address feedback.", sub: ["Check reviews and messages daily.", "Reply professionally and promptly to positive and negative reviews.", "Escalate concerning reviews to the manager."] },
        { title: "WeddingPro", text: "Handle wedding inquiries and keep our profile current.", sub: ["Keep the profile updated with new images, reviews, and promotions.", "Reply to every inquiry within 24 hours."] },
        { title: "Quo", text: "All customer calls and texts.", sub: ["Answer inbound calls and texts.", "Make follow up calls to confirm bookings or address concerns.", "Stay professional and polite in every interaction."] },
        { title: "Whimsical", text: "Team SOPs and visual workflows.", sub: ["Read and update SOPs and workflows.", "Collaborate on process maps and troubleshooting guides."] },
        { title: "Goodshuffle", text: "Bookings, inventory, and quotes.", sub: ["Create and change customer orders.", "Allocate inventory to each booking so items are available.", "Build quotes and follow up on pending bookings.", "Keep customer records and notes current."] },
        { title: "Work email and calendar", text: "Email customers and manage bookings, meetings, and deadlines. Share your availability for calls." },
        { title: "Slack", text: "Talk with the team in real time and report customer issues and feedback." },
        { title: "Connecteam", text: "Your schedule and time clock." },
        { title: "Lockly", text: "Your door access key, set up in the Lockly phone app." },
      ],
    },
    {
      heading: "3. Communication guidelines",
      items: [
        { title: "Tone", text: "Friendly, professional, and helpful." },
        { title: "Response time", text: "Reply to every customer inquiry (phone, email, platforms) within 24 hours." },
        { title: "Escalation", text: "If you cannot resolve an issue or it needs a manager's approval, escalate promptly to the designated team member." },
      ],
    },
    {
      heading: "4. Customer support workflow",
      items: [
        { title: "Initial inquiry", text: "Review and sort inquiries from Yelp, WeddingPro, and Quo. Acknowledge the customer and give a follow up timeline if it is complex." },
        { title: "Booking support", text: "Use Goodshuffle to check availability, build quotes, and update bookings. Confirm date, location, and items with the customer, and follow up before the event." },
        { title: "Problems and feedback", text: "Watch Yelp feedback. If a customer is unhappy, resolve it by Quo or email, and document the feedback and the resolution." },
      ],
    },
    {
      heading: "5. Reporting and metrics",
      items: [
        { title: "Customer satisfaction", text: "Tracked through reviews, feedback, and follow up surveys." },
        { title: "Response time", text: "How long it takes to answer customer inquiries." },
        { title: "Conversion", text: "Inquiries that become confirmed bookings in Goodshuffle." },
      ],
    },
    {
      heading: "6. Ongoing training and support",
      items: [
        { title: "Check ins", text: "Meet with your manager at 30, 60, and 90 days, then monthly, for feedback, updates, and goals." },
        { title: "Continuous learning", text: "Stay current on new platforms, tools, and process changes." },
      ],
    },
    {
      heading: "7. Etiquette and policies",
      items: [
        { title: "Confidentiality", text: "Keep customer information private and share it only within the team when needed." },
        { title: "Professional conduct", text: "Stay professional on the phone, in writing, and in person." },
        { title: "Time management", text: "Prioritize well, especially in peak event season." },
        {
          title: "Attendance and punctuality",
          text: "Regular attendance and punctuality are required. Unexcused absences, tardiness, or no call no shows lead to progressive discipline, up to and including termination. Multiple violations may result in immediate termination without further warning.",
        },
        {
          title: "Professional appearance",
          text: "Keep good hygiene, clean and neat attire, and present yourself in a way that reflects well on the company and our clients. This role is client facing, so a polished appearance is expected while on duty.",
          sub: [
            "Hair: clean and neatly kept. Zoe Event Rentals does not restrict natural hair textures or protective styles, including braids, locs, and twists, in line with Maryland law.",
            "Facial hair: clean and neatly groomed.",
            "Tattoos: you may be asked to cover visible tattoos depending on your role, work setting, or client contact. We will tell you at onboarding.",
          ],
        },
      ],
    },
  ],
  signOff: "I have read and understood this document.",
};

const SOPS: Record<string, Sop> = { sales_associate: SALES_ASSOCIATE };

/** The SOP for an access policy id, or null if that role has none. */
export function sopFor(policyId: string | null | undefined): Sop | null {
  return policyId ? (SOPS[policyId] ?? null) : null;
}
