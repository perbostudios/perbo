import {
  EXECUTOR_SKILLS,
  type ExecutorSkillId,
} from "@perbo/contracts/executor-skills";

export function SkillPicker({
  selected,
  onChange,
}: {
  selected: readonly ExecutorSkillId[];
  onChange: (ids: ExecutorSkillId[]) => void;
}) {
  return (
    <details className="skill-picker">
      <summary>Engineering skills · {selected.length} selected</summary>
      <p className="small muted">
        Matt Pocock’s skills. Choose up to three for the executor. Each run
        records the version used.
      </p>
      <div className="skill-options">
        {EXECUTOR_SKILLS.map((skill) => (
          <label key={skill.id} title={skill.description}>
            <input
              type="checkbox"
              checked={selected.includes(skill.id)}
              disabled={selected.length >= 3 && !selected.includes(skill.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, skill.id]
                    : selected.filter((id) => id !== skill.id),
                )
              }
            />
            <span>
              <strong>{skill.label}</strong>
              <span className="small muted">{skill.description}</span>
            </span>
          </label>
        ))}
      </div>
    </details>
  );
}
