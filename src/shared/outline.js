import { PDFDocument, PDFName, PDFNumber, PDFRef, PDFHexString } from 'pdf-lib';

// Build a tree structure from flat items with levels
const buildOutlineTree = (flatItems) => {
  const root = { children: [] };
  const stack = [{ node: root, level: -1 }];
  
  for (const item of flatItems) {
    const node = {
      id: item.id ?? crypto.randomUUID(),
      title: item.title ?? 'Untitled',
      pageIndex: item.pageIndex ?? 0,
      level: item.level ?? 0,
      children: []
    };
    
    // Pop stack until we find the correct parent level
    while (stack.length > 1 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    
    // Add as child of current top of stack
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, level: node.level });
  }
  
  return root.children;
};

// Create PDF outline entries with proper hierarchy
const createOutlineEntries = ({ pdfDoc, tree }) => {
  const context = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const outlineRootRef = context.nextRef();
  
  // First, count all items and create refs
  const allItems = [];
  const collectItems = (items, parentRef) => {
    items.forEach((item, idx) => {
      const ref = context.nextRef();
      const siblings = items;
      allItems.push({ item, ref, parentRef, siblings, idx });
      collectItems(item.children, ref);
    });
  };
  collectItems(tree, outlineRootRef);
  
  // Create a map of item to ref
  const itemToRef = new Map();
  allItems.forEach(({ item, ref }) => itemToRef.set(item, ref));
  
  // Count total visible items
  const countItems = (items) => {
    let count = 0;
    for (const item of items) {
      count += 1 + countItems(item.children);
    }
    return count;
  };
  
  const totalCount = countItems(tree);
  
  // Create outline root
  const outlineRoot = context.obj({
    Type: PDFName.of('Outlines'),
    First: tree.length > 0 ? itemToRef.get(tree[0]) : null,
    Last: tree.length > 0 ? itemToRef.get(tree[tree.length - 1]) : null,
    Count: PDFNumber.of(totalCount)
  });
  
  // Create entries
  const entries = [];
  for (const { item, ref, parentRef, siblings, idx } of allItems) {
    const page = pages[item.pageIndex] ?? pages[0];
    const pageRef = page.ref;
    const destArray = context.obj([pageRef, PDFName.of('XYZ'), null, null, null]);
    
    const prevItem = idx > 0 ? siblings[idx - 1] : null;
    const nextItem = idx < siblings.length - 1 ? siblings[idx + 1] : null;
    const firstChild = item.children.length > 0 ? item.children[0] : null;
    const lastChild = item.children.length > 0 ? item.children[item.children.length - 1] : null;
    
    const childCount = countItems(item.children);
    
    const entryDict = {
      Title: PDFHexString.fromText(item.title),
      Parent: parentRef,
      Dest: destArray
    };
    
    if (prevItem) entryDict.Prev = itemToRef.get(prevItem);
    if (nextItem) entryDict.Next = itemToRef.get(nextItem);
    if (firstChild) {
      entryDict.First = itemToRef.get(firstChild);
      entryDict.Last = itemToRef.get(lastChild);
      entryDict.Count = PDFNumber.of(childCount);
    }
    
    entries.push({ ref, entry: context.obj(entryDict) });
  }
  
  return { outlineRootRef, outlineRoot, entries };
};

const flattenOutline = (items) => {
  const result = [];
  const walk = (node) => {
    result.push(node);
    node.children.forEach(walk);
  };
  items.forEach(walk);
  return result;
};

export const extractOutline = async (data) => {
  const pdfDoc = await PDFDocument.load(data);
  const outline = pdfDoc.context.lookup(pdfDoc.catalog.get(PDFName.of('Outlines')));

  if (!outline) {
    return [];
  }

  const outlinesDict = outline;
  const firstRef = outlinesDict.get(PDFName.of('First'));
  const outlineItems = [];

  const walk = (ref, level = 0) => {
    if (!ref) return;
    const item = pdfDoc.context.lookup(ref);
    if (!item) return;

    const title = item.get(PDFName.of('Title'))?.decodeText?.() ?? 'Untitled';
    
    // Extract page index from Dest or A (Action)
    let pageIndex = 0;
    const dest = item.get(PDFName.of('Dest'));
    const action = item.get(PDFName.of('A'));
    
    if (dest) {
      const destArray = pdfDoc.context.lookup(dest);
      if (destArray && destArray.asArray) {
        const pageRef = destArray.asArray()[0];
        if (pageRef instanceof PDFRef) {
          const pages = pdfDoc.getPages();
          pageIndex = pages.findIndex(p => p.ref.toString() === pageRef.toString());
          if (pageIndex === -1) pageIndex = 0;
        }
      }
    } else if (action) {
      const actionDict = pdfDoc.context.lookup(action);
      if (actionDict) {
        const actionDest = actionDict.get(PDFName.of('D'));
        if (actionDest) {
          const destArray = pdfDoc.context.lookup(actionDest);
          if (destArray && destArray.asArray) {
            const pageRef = destArray.asArray()[0];
            if (pageRef instanceof PDFRef) {
              const pages = pdfDoc.getPages();
              pageIndex = pages.findIndex(p => p.ref.toString() === pageRef.toString());
              if (pageIndex === -1) pageIndex = 0;
            }
          }
        }
      }
    }

    outlineItems.push({
      id: crypto.randomUUID(),
      title,
      pageIndex,
      level,
      children: []
    });

    // Process children first
    const firstChild = item.get(PDFName.of('First'));
    if (firstChild) {
      walk(firstChild, level + 1);
    }

    // Then process siblings
    const nextRef = item.get(PDFName.of('Next'));
    if (nextRef) {
      walk(nextRef, level);
    }
  };

  if (firstRef) {
    walk(firstRef);
  }

  return outlineItems;
};

export const applyOutlineToPdf = async (data, outlineItems) => {
  const pdfDoc = await PDFDocument.load(data);

  const sanitized = outlineItems.map((item) => ({
    ...item,
    title: item.title ?? 'Untitled',
    pageIndex: Math.max(0, item.pageIndex ?? 0),
    level: item.level ?? 0
  }));

  if (sanitized.length === 0) {
    return pdfDoc.save();
  }

  // Build hierarchical tree from flat items
  const tree = buildOutlineTree(sanitized);

  const { outlineRootRef, outlineRoot, entries } = createOutlineEntries({
    pdfDoc,
    tree
  });

  pdfDoc.context.assign(outlineRootRef, outlineRoot);
  entries.forEach(({ ref, entry }) => {
    pdfDoc.context.assign(ref, entry);
  });

  pdfDoc.catalog.set(PDFName.of('Outlines'), outlineRootRef);

  return pdfDoc.save();
};
