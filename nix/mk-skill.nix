{ runCommand }:

# Builder for entries that are documentation only — a skill describing a tool
# that already exists (in nixpkgs, say), with nothing of our own to compile.
# The output has the same shape every other package here has:
#
#   $out/share/skills/<name>/SKILL.md
#
# so the home-manager modules and any harness reading `share/skills/` cannot
# tell the difference.
{
  name,
  src,
  meta ? { },
}:

runCommand "skill-${name}"
  {
    inherit src;
    pname = name;

    # Consumers resolve the skill directory from the attribute rather than by
    # reading the store path, which would force the derivation at eval time.
    passthru.skillName = name;

    meta = {
      description = "Agent skill: ${name}";
    }
    // meta;
  }
  ''
    if [ ! -f "$src/SKILL.md" ]; then
      echo "skill ${name}: $src/SKILL.md does not exist" >&2
      exit 1
    fi

    # The frontmatter name is what the harness shows the model; keep it in sync
    # with the directory name so a rename cannot silently split the two.
    declared=$(sed -n '2,/^---$/{s/^name:[[:space:]]*//p}' "$src/SKILL.md" | head -1)
    if [ "$declared" != "${name}" ]; then
      echo "skill ${name}: SKILL.md declares name '$declared'" >&2
      exit 1
    fi

    mkdir -p "$out/share/skills"
    cp -r "$src" "$out/share/skills/${name}"
  ''
