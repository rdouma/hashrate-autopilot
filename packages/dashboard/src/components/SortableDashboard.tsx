// #244: drag-to-reorder for the top-level dashboard blocks.
//
// Rather than an always-on grip on every card (which would collide
// with each card's existing top-right refresh countdown, and whose
// drag gesture would fight the charts' own pan/zoom drag), reordering
// lives behind an explicit "Rearrange" mode. While editing, each block
// gets a labelled drag bar and its content is inert (pointer-events
// off) so a stray tap can't fire a button mid-drag; outside edit mode
// the blocks render exactly as before with zero wrappers and no DnD
// listeners mounted.
//
// Persistence + reconciliation against the live block set lives in
// lib/cardOrder.ts; this component is purely the drag surface.

import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export interface DashboardBlock {
  /** Stable block ID, persisted in the saved order. */
  id: string;
  /** Human-readable, translated label shown on the drag bar. */
  label: string;
  /** The rendered block. */
  node: React.ReactNode;
}

function GripIcon() {
  // Lucide grip-vertical - the universal drag-handle affordance.
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <circle cx="9" cy="5" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="19" r="1" />
    </svg>
  );
}

function SortableItem({
  block,
  dragHint,
}: {
  block: DashboardBlock;
  dragHint: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: block.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
    zIndex: isDragging ? 30 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-lg ring-2 ${
        isDragging
          ? 'ring-emerald-500 shadow-lg shadow-black/40'
          : 'ring-slate-700/60'
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        title={dragHint}
        aria-label={`${dragHint}: ${block.label}`}
        className="flex w-full items-center gap-2 rounded-t-lg bg-slate-800 px-3 py-1.5 text-left text-xs font-medium uppercase tracking-wider text-slate-200 cursor-grab active:cursor-grabbing touch-none select-none hover:bg-slate-700"
      >
        <GripIcon />
        <span className="truncate">{block.label}</span>
      </button>
      {/* Content is inert while rearranging so taps can't trigger the
          card's own controls (buttons, chart pan/zoom) mid-drag. */}
      <div className="pointer-events-none p-2 opacity-80">{block.node}</div>
    </div>
  );
}

export function SortableDashboard({
  blocks,
  editing,
  onReorder,
  dragHint,
}: {
  blocks: DashboardBlock[];
  editing: boolean;
  onReorder: (ids: string[]) => void;
  /** Translated "drag to reorder" hint for the bar tooltip/aria. */
  dragHint: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Small distance gate so a click on the bar doesn't register as a
      // drag; matters on desktop.
      activationConstraint: { distance: 4 },
    }),
    useSensor(TouchSensor, {
      // Short press-and-hold to start on touch, so vertical scrolling
      // through the (now-tall) edit view isn't hijacked.
      activationConstraint: { delay: 180, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!editing) {
    // Zero-overhead path: render the blocks plain, exactly as before.
    return (
      <>
        {blocks.map((b) => (
          <div key={b.id}>{b.node}</div>
        ))}
      </>
    );
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = blocks.map((b) => b.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={blocks.map((b) => b.id)}
        strategy={verticalListSortingStrategy}
      >
        {blocks.map((b) => (
          <SortableItem key={b.id} block={b} dragHint={dragHint} />
        ))}
      </SortableContext>
    </DndContext>
  );
}
