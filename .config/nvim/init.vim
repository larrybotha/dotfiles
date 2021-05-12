set runtimepath^=~/.vim runtimepath+=~/.vim/after
let &packpath = &runtimepath

source ~/.vimrc

" source lua/init.lua
let s:load_dir = expand('<sfile>:p:h')
exec printf('luafile %s/lua/init.lua', s:load_dir)
