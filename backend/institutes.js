// Partner institutes — universities/colleges UPSY has a tie-up with. An applicant
// headed to a partner institute gets a visible perk (faster processing, better
// pricing with some lenders) and the team dashboard flags the file as partner.
// Matching is a forgiving contains/alias check so "IIM Bangalore", "IIM-B" and
// "Indian Institute of Management Bangalore" all resolve to the same partner.

export const PARTNER_INSTITUTES = [
  { name: "IIM Bangalore", country: "India", aliases: ["iim bangalore", "iim-b", "iimb", "indian institute of management bangalore"], perk: "Pre-approved partner — faster sanction and preferential rates with partner lenders." },
  { name: "IIM Ahmedabad", country: "India", aliases: ["iim ahmedabad", "iim-a", "iima"], perk: "Pre-approved partner — faster sanction and preferential rates with partner lenders." },
  { name: "IIT Bombay", country: "India", aliases: ["iit bombay", "iit-b", "iitb"], perk: "Pre-approved partner — faster sanction with partner lenders." },
  { name: "IIT Delhi", country: "India", aliases: ["iit delhi", "iit-d", "iitd"], perk: "Pre-approved partner — faster sanction with partner lenders." },
  { name: "BITS Pilani", country: "India", aliases: ["bits pilani", "bits"], perk: "Partner institute — streamlined document processing." },
  { name: "University of Texas", country: "US", aliases: ["university of texas", "ut austin", "ut-austin"], perk: "Partner institute — recognised by all partner lenders for US study loans." },
  { name: "Stanford University", country: "US", aliases: ["stanford"], perk: "Partner institute — recognised by all partner lenders for US study loans." },
  { name: "INSEAD", country: "France", aliases: ["insead"], perk: "Partner institute — recognised by all partner lenders for European study loans." },
  { name: "NUS", country: "Singapore", aliases: ["nus", "national university of singapore"], perk: "Partner institute — recognised by all partner lenders." },
  { name: "University of Toronto", country: "Canada", aliases: ["university of toronto", "uoft", "u of t"], perk: "Partner institute — recognised by all partner lenders for Canada study loans." },
];

// Resolve a free-text institute name to a partner record, or null.
export function matchInstitute(name) {
  if (!name) return null;
  const n = String(name).toLowerCase().trim();
  return (
    PARTNER_INSTITUTES.find(
      (p) => p.name.toLowerCase() === n || p.aliases.some((a) => n.includes(a) || a.includes(n))
    ) || null
  );
}
