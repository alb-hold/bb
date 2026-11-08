import { useEffect, useRef, useState, type ReactNode } from "react";

export function ThreadRowMetadata({
  project,
  branch = null,
  age,
}: {
  project: string | null;
  branch?: string | null;
  age: ReactNode;
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const projectRef = useRef<HTMLSpanElement>(null);
  const ageRef = useRef<HTMLSpanElement>(null);
  const separatorRef = useRef<HTMLSpanElement>(null);
  const minimumRef = useRef<HTMLSpanElement>(null);
  const [showBranch, setShowBranch] = useState(true);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !branch) return;
    const measure = () => {
      const width = container.getBoundingClientRect().width;
      if (width === 0) return;
      const available =
        width -
        (projectRef.current?.getBoundingClientRect().width ?? 0) -
        (ageRef.current?.getBoundingClientRect().width ?? 0) -
        (separatorRef.current?.getBoundingClientRect().width ?? 0) *
          (project ? 2 : 1);
      setShowBranch(
        available >= (minimumRef.current?.getBoundingClientRect().width ?? 0),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [
      container,
      projectRef.current,
      ageRef.current,
      minimumRef.current,
    ]) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [project, branch]);
  const visibleBranch = branch !== null && showBranch;
  return (
    <span
      ref={containerRef}
      className="relative flex min-w-0 flex-1 items-center whitespace-nowrap"
      data-thread-context-metadata=""
    >
      {project ? (
        <span
          ref={projectRef}
          className="max-w-[min(14ch,60%)] shrink-0 truncate"
          data-thread-row-project=""
        >
          {project}
        </span>
      ) : null}
      {project && visibleBranch ? (
        <span className="shrink-0 whitespace-pre">{" · "}</span>
      ) : null}
      {visibleBranch ? (
        <span className="min-w-0 truncate" data-thread-row-branch="">
          {branch}
        </span>
      ) : null}
      {project || visibleBranch ? (
        <span className="shrink-0 whitespace-pre">{visibleBranch ? "· " : " · "}</span>
      ) : null}
      <span ref={ageRef} className="shrink-0">
        {age}
      </span>
      {branch ? (
        <span
          aria-hidden
          className="pointer-events-none invisible absolute flex"
        >
          <span
            ref={separatorRef}
            className="whitespace-pre before:content-[attr(data-measure)]"
            data-measure=" · "
          />
          <span
            ref={minimumRef}
            className="before:content-[attr(data-measure)]"
            data-measure={`${Array.from(branch).slice(0, 6).join("")}${Array.from(branch).length > 6 ? "…" : ""}`}
          />
        </span>
      ) : null}
    </span>
  );
}
