{ mkSkill }:

# Documentation only: the tool it describes is `tea`, Gitea's official CLI,
# which comes from nixpkgs. Install `tea` alongside this.
mkSkill {
  name = "gitea";
  src = ./skill;
  meta.description = "Read and write Gitea issues from the command line via tea";
}
