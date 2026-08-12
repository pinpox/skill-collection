{ mkSkill }:

# Documentation only: the tool it describes is `vja` from nixpkgs, so there is
# nothing to build here. Install `vja` alongside this.
mkSkill {
  name = "todos";
  src = ./skill;
  meta.description = "Manage Vikunja todos from the command line via vja";
}
