// Counting the rows a FetchXML query matches, without reading them: an
// aggregate count first; when Dataverse refuses (more than 50,000 rows to
// aggregate), paging through the table's key only.

/** The query's columns, sorts and paging removed (its filters and joins kept). */
function stripped(xml: string): XMLDocument | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  const root = doc.documentElement;
  for (const a of ["top", "count", "page", "paging-cookie", "returntotalrecordcount"]) root.removeAttribute(a);
  for (const tag of ["attribute", "all-attributes", "order"]) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) el.remove();
  }
  return doc;
}

const entityOf = (doc: XMLDocument) => doc.getElementsByTagName("entity")[0] ?? null;

/** `<fetch aggregate="true">` counting the rows (as `rowcount`). */
export function aggregateCountQuery(xml: string, primaryId: string): string | null {
  const doc = stripped(xml);
  const entity = doc && entityOf(doc);
  if (!doc || !entity) return null;
  doc.documentElement.removeAttribute("distinct");
  doc.documentElement.setAttribute("aggregate", "true");
  const attr = doc.createElement("attribute");
  attr.setAttribute("name", primaryId);
  attr.setAttribute("alias", "rowcount");
  attr.setAttribute("aggregate", "count");
  entity.insertBefore(attr, entity.firstChild);
  return new XMLSerializer().serializeToString(doc);
}

/** The query reading only the table's key, sorted by it (for paging when aggregate counts are refused). */
export function keyOnlyQuery(xml: string, primaryId: string): string | null {
  const doc = stripped(xml);
  const entity = doc && entityOf(doc);
  if (!doc || !entity) return null;
  const distinct = new DOMParser().parseFromString(xml, "application/xml").documentElement.getAttribute("distinct") === "true";
  if (distinct) return null; // distinct rows depend on the columns picked
  doc.documentElement.setAttribute("count", "5000");
  const attr = doc.createElement("attribute");
  attr.setAttribute("name", primaryId);
  const order = doc.createElement("order");
  order.setAttribute("attribute", primaryId);
  entity.insertBefore(order, entity.firstChild);
  entity.insertBefore(attr, entity.firstChild);
  return new XMLSerializer().serializeToString(doc);
}

/** Dataverse won't aggregate this many rows. */
export const tooManyToAggregate = (error: string) => /AggregateQueryRecordLimit|0x8004e023|aggregate.*50,?000/i.test(error);
