# Shared option module imported by every per-skill homeModule (and by the
# `programs.skill-collection` module). Lets the user pick which agent harnesses
# get the skill definitions symlinked, instead of hard-coding one harness in
# every skill.
{ lib, ... }:
{
  key = "skill-collection/common";

  options.programs.skill-collection = {
    skillDirs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        ".claude/skills"
        ".omp/agent/skills"
      ];
      example = [ ".claude/skills" ];
      description = ''
        Directories (relative to `$HOME`) into which each enabled skill's
        definition is symlinked as `<dir>/<skill>/`. One entry per agent
        harness that should discover the skills.
      '';
    };
  };
}
