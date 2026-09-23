import {
  EXECUTOR_SKILLS,
  type ExecutorSkillId,
} from "@perbo/contracts/browser";

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
            <strong>{skill.label}</strong>
          </label>
        ))}
      </div>
    </details>
  );
}
