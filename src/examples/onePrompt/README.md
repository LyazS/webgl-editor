# One Prompt shots

`main.lua` is the project entry point and plays shot 1 followed by shot 2 on one continuous timeline.

- `shot1/`: the first `unfold` shot, including its Lua animation modules and shot-specific shaders.
- `shot2/`: the second `construct` shot, currently under pixel calibration.
- `shot1/lib/icons/`: one rewind geometry module per icon (`01-leader.lua` … `16-premiere.lua`).
- `shared/lua/`: Lua helpers reusable by later shots.
- `shared/shaders/`: shader programs reusable by later shots.

New shots should live in `shot2/`, `shot3/`, and so on. Keep their geometry, animation logic and private shaders inside the shot folder; move a helper into `shared/` only when another shot uses it.
