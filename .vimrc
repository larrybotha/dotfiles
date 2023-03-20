" Modeline and Notes {
" vim: set foldmarker={,} foldlevel=0 foldmethod=marker spell:
"  This .vimrc is largely inspired by
"  https://github.com/spf13/spf13-vim/blob/master/.vimrc and
"  https://github.com/kmckelvin/vimrc/blob/master/vimrc
" }

" Environment {
  " Basics {
    set nocompatible " must come first
    set background=dark " assume a dark background
  "}
"}

" Plugin Installation {
  " install Plug if it isn't already
  if empty(glob('~/.vim/autoload/plug.vim'))
    silent !curl -fLo ~/.vim/autoload/plug.vim --create-dirs
      \ https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim
    autocmd VimEnter * PlugInstall --sync | source $MYVIMRC
  endif

  " conditionally get options
  function! Cond(cond, ...)
    let opts = get(a:000, 0, {})
    return a:cond ? opts : extend(opts, { 'on': [], 'for': [] })
  endfunction

  call plug#begin('~/.vim/plugged')

  Plug 'wakatime/vim-wakatime'

  Plug 'dense-analysis/ale'

  Plug 'skywind3000/asynctasks.vim'
  Plug 'skywind3000/asyncrun.vim'
  Plug 'voldikss/vim-floaterm'

  Plug 'rking/ag.vim'
  Plug 'junegunn/fzf', { 'dir': '~/.fzf', 'do': './install --all' }
  Plug 'junegunn/fzf.vim'

  Plug 'tpope/vim-sensible'
  Plug 'tpope/vim-fugitive'
  Plug 'tpope/vim-surround'
  Plug 'tpope/vim-endwise'

  Plug 'Raimondi/delimitMate'
  Plug 'christoomey/vim-tmux-navigator'
  Plug 'editorconfig/editorconfig-vim'
  Plug 'edkolev/tmuxline.vim'
  Plug 'mcchrish/nnn.vim'
  Plug 'godlygeek/tabular'
  Plug 'preservim/nerdcommenter'
  Plug 'rhysd/git-messenger.vim'
  Plug 'terryma/vim-multiple-cursors'
  Plug 'tmux-plugins/vim-tmux-focus-events'
  Plug 'vim-airline/vim-airline'
  Plug 'vim-airline/vim-airline-themes'
  Plug 'heavenshell/vim-jsdoc', {
  \ 'for': ['javascript', 'javascript.jsx','typescript'],
  \ 'do': 'make install'
  \}
  Plug 'janko-m/vim-test'
  Plug 'prettier/vim-prettier'
  Plug 'ruanyl/vim-sort-imports'
  Plug 'dkarter/bullets.vim'
  Plug 'puremourning/vimspector'
  Plug 'preservim/vimux'

  " Language support
  Plug 'sheerun/vim-polyglot'
  Plug 'simrat39/rust-tools.nvim'
  "Plug 'rust-lang/rust.vim'
  Plug 'evanleck/vim-svelte', {'branch': 'main'}
  Plug 'mattn/emmet-vim'
  Plug 'fatih/vim-go', {'do': ':GoInstallBinaries'}

  " only load if we are in Neovim
  Plug 'jodosha/vim-godebug', Cond(has('nvim'))
  Plug 'neovim/nvim-lspconfig', Cond(has('nvim'))
  Plug 'nvim-treesitter/nvim-treesitter', Cond(has('nvim'), {'do': ':TSUpdate'})
  Plug 'ojroques/nvim-lspfuzzy', Cond(has('nvim'))

  " completion
  Plug 'hrsh7th/cmp-nvim-lsp'
  Plug 'hrsh7th/cmp-buffer'
  Plug 'hrsh7th/cmp-path'
  Plug 'hrsh7th/cmp-cmdline'
  Plug 'hrsh7th/nvim-cmp'
  Plug 'hrsh7th/vim-vsnip'

  " telescope and deps
  if has('nvim')
    Plug 'nvim-lua/popup.nvim'
    Plug 'nvim-lua/plenary.nvim'"
    Plug 'nvim-telescope/telescope.nvim'
    Plug 'nvim-telescope/telescope-fzf-native.nvim', { 'do': 'make' }
    Plug 'kyazdani42/nvim-web-devicons'
    Plug 'GustavoKatel/telescope-asynctasks.nvim'
    Plug 'lukas-reineke/indent-blankline.nvim'
    Plug 'lewis6991/gitsigns.nvim'
  end

  call plug#end()
"}

" General {
  filetype plugin indent on " automatically detect files types
  syntax on                 " syntax highlighting
  set mouse=a               " automatically enable mouse usage
  scriptencoding utf-8
  set history=1000          " store more history (default is 20)
  set nospell               " spell checking off
  set noswapfile            " don't use swapfiles

  " don't create backup files
  set nobackup
  set nowritebackup

  if !has('nvim')
    " remove the delay when hitting esc in insert mode
    set noesckeys
  endif

  set ttimeout
  set ttimeoutlen=1

  set showbreak=↪

  set fillchars=diff:·

  " check for external file changes, and suppress notices from appearing in command line
  " requires tmux-focus-events plugin for tmux support
  au FocusGained,BufEnter * :checktime " when buffer is changed
  " when cursor stops moving
  " https://vi.stackexchange.com/questions/14315/how-can-i-tell-if-im-in-the-command-window
  autocmd FocusGained,BufEnter,CursorHold,CursorHoldI *
    \ if mode() == 'n' && getcmdwintype() == '' | checktime | endif
  set autoread

  if has('mouse_sgr')
    set ttymouse=sgr
  endif
" }

" Vim UI {
  source ~/.vim/local/highlight.vim
  colorscheme monokai                            " load a colourscheme
  set termguicolors                              " use gui color attributes instead of cterm attributes
  set splitright                                 " open split panes to the right of the current pane
  set splitbelow                                 " open split panes underneath the current pane

  set backspace=indent,eol,start                 " allow backspacing over everything in insert mode
  set linespace=0                                " No extra spaces between rows
  set number relativenumber                      " use hybrid line numbers
  set showmatch                                  " show matching brackets/parenthesis
  set incsearch                                  " find as you type search
  set hlsearch                                   " highlight search terms
  set winminheight=0                             " windows can be 0 line high
  set ignorecase                                 " case insensitive search
  set smartcase                                  " case sensitive when uc present
  set wildmenu                                   " show list instead of just completing
  set wildmode=list:longest,full                 " command <Tab> completion, list matches, then longest common part, then all.
  set nowrap                                     " don't wrap lines
  set scrolljump=5                               " lines to scroll when cursor leaves screen
  set scrolloff=5                                " minimum lines to keep above and below cursor
  noh                                            " clear the initial highlight after sourcing
  set foldenable                                 " auto fold code
  set nospell                                    " disable spellcheck
  set shortmess=atI                              " prevent 'Press ENTER' prompt
  set cursorline                                 " highlight current line
  set cursorcolumn                               " highlight current column

  set colorcolumn=85                             " show column length hint for long lines

  " show timeout on leader
  set showcmd

  " moving panes
  noremap <leader>mh :wincmd H<CR>
  noremap <leader>mj :wincmd J<CR>
  noremap <leader>mk :wincmd K<CR>
  noremap <leader>ml :wincmd L<CR>

  " change cursor to caret when in insert mode in tmux
  if exists('$TMUX')
    let &t_SI = "\<Esc>Ptmux;\<Esc>\<Esc>]50;CursorShape=1\x7\<Esc>\\"
    let &t_EI = "\<Esc>Ptmux;\<Esc>\<Esc>]50;CursorShape=0\x7\<Esc>\\"
  else
    let &t_SI = "\<Esc>]50;CursorShape=1\x7"
    let &t_EI = "\<Esc>]50;CursorShape=0\x7"
  endif
" }

" Formatting {
  set autoindent                                          " indent at the same level of the previous line
  set shiftwidth=2                                        " use indents of 2 spaces
  set tabstop=2                                           " indent every 2 columns
  set softtabstop=2                                       " let backspace delete indent
  set expandtab
  autocmd BufNewFile,BufReadPost * set ai ts=2 sw=2 sts=2 " set above values when opening new files
" }

" Key Mappings {
  " set custom leader
  let mapleader = ','

  " j and k navigate through wrapped lines
  nmap k gk
  nmap j gj

  " map common shift keys
  cmap Qall qall
  cmap Tabe tabe

  " yank from cursor to EOL the same as C and D do
  nnoremap Y y$

  " code folding options
  nmap <leader>f0 :set foldlevel=0<CR>
  nmap <leader>f1 :set foldlevel=1<CR>
  nmap <leader>f2 :set foldlevel=2<CR>
  nmap <leader>f3 :set foldlevel=3<CR>
  nmap <leader>f4 :set foldlevel=4<CR>
  nmap <leader>f5 :set foldlevel=5<CR>
  nmap <leader>f6 :set foldlevel=6<CR>
  nmap <leader>f7 :set foldlevel=7<CR>
  nmap <leader>f8 :set foldlevel=8<CR>
  nmap <leader>f9 :set foldlevel=9<CR>

  " clear highlighted searches
  nnoremap <silent> <leader>/ :nohlsearch<CR>

  " visual shifting without exiting visual mode
  vnoremap < <gv
  vnoremap > >gv

  " quickly move lines up and down with <A-J> == ∆ and <A-K> == ˚
  nnoremap ∆ :m .+1<CR>==
  nnoremap ˚ :m .-2<CR>==
  inoremap ∆ <Esc>:m .+1<CR>==gi
  inoremap ˚ <Esc>:m .-2<CR>==gi
  vnoremap ∆ :m '>+1<CR>gv=gv
  vnoremap ˚ :m '<-2<CR>gv=gv

  " paste, fix indentation and clear the mark by default
  nnoremap p p=`]`<esc>

  " quickly move to next and previous buffers
  map <leader>bn :bn<CR>
  map <leader>bp :bp<CR>

  " quick access to this .vimrc
  map <leader>vi :tabe ~/projects/dotfiles/.vimrc<CR>
  map <leader>vs :source $MYVIMRC<CR>

  " set all windows to equal width
  map <leader>= <C-w>=
" }

" Auto Commands {

  if has("autocmd")
    " Also load indent files, to automatically do language-dependent indenting.

    " Put these in an autocmd group, so that we can delete them easily.
    augroup vimrcEx
      autocmd!

      " For all text files set 'textwidth' to 80 characters.
      autocmd BufRead *.txt,*.md,*.svx,*.textile set textwidth=80

      " Set .svx files as markdown
      " TODO: move to filetype plugin
      autocmd BufRead *.svx set ft=markdown

      " Delete trailing white space on save
      autocmd BufWritePre * :%s/\s\+$//e

      " When editing a file, always jump to the last known cursor position.
      " Don't do it when the position is invalid or when inside an event handler
      " (happens when dropping a file on gvim).
      autocmd BufReadPost *
        \ if line("'\"") > 0 && line("'\"") <= line("$") |
        \  exe "normal g`\"" |
        \ endif
    augroup END

    " Use hybrid line numbers when in any mode other than 'insert' mode,
    " otherwise use 'number'
    augroup numbertoggle
      autocmd!

      autocmd BufEnter,FocusGained,InsertLeave,WinEnter *
        \ if &number && mode() != "i"
        \ | set relativenumber | endif
      autocmd BufLeave,FocusLost,InsertEnter,WinLeave *
        \ if &number
        \ | set norelativenumber | endif
    augroup END
  endif " has("autocmd")

" }

" Plugin Configs {
  " Plug {
    " Update / Install bundles
    map <leader>vbi :PlugInstall<CR>
    map <leader>vbu :PlugUpdate<CR>
  " }

source ~/.vim/local/neovim.vim

source ~/.vim/local/plugins/airline.vim
source ~/.vim/local/plugins/ale.vim
source ~/.vim/local/plugins/asynctasks.vim
source ~/.vim/local/plugins/cmp.vim
source ~/.vim/local/plugins/endwise.vim
source ~/.vim/local/plugins/floaterm.vim
source ~/.vim/local/plugins/nerdcommenter.vim
source ~/.vim/local/plugins/nnn.vim
source ~/.vim/local/plugins/telescope.vim
source ~/.vim/local/plugins/vim-pydocstring.vim
source ~/.vim/local/plugins/vim-sort-imports.vim
source ~/.vim/local/plugins/vimspector/index.vim
source ~/.vim/local/plugins/vimux.vim
source ~/.vim/local/plugins/vim-test.vim
source ~/.vim/local/plugins/vim-tmux-navigator.vim



  " vim-svelte {
    let g:svelte_preprocessors = ['typescript', 'scss']
  " }


  " delimitMate {
    " expand a new line after a brace to autoindent
    let delimitMate_expand_cr = 1
    " if parentheses are opened with a space, add a matching space after the cursor
    let delimitMate_expand_space = 1
  " }

  " rust-lang/rust {
    let g:autofmt_autosave = 1
  " }

 " vim-go {
    " format and rewrite imports on save
    let g:go_fmt_command = 'goimports'
    " show type info under cursor
    let g:go_auto_type_info = 1
  " }

  " Fugitive {
    " git push
    nmap <leader>gp :exec ':Git push origin ' . fugitive#head()<CR>

    " git status
    map <silent> <leader>gs :Git<CR>

    " git commit -am "
    map <leader>gci :Git commit -am "

    " git checkout
    map <leader>gco :Git checkout<space>

    " git diff
    map <leader>gd :Gdiff<CR>
  " }

  " fzf {
    " --column: Show column number
    " --line-number: Show line number
    " --no-heading: Do not show file headings in results
    " --fixed-strings: Search term as a literal string
    " --ignore-case: Case insensitive search
    " --no-ignore: Do not respect .gitignore, etc...
    " --hidden: Search hidden files and folders
    " --follow: Follow symlinks
    " --glob: Additional conditions for search (in this case ignore everything in the .git/ folder)
    " --color: Search color options
    let g:rg_command = 'rg --column --line-number --no-heading --fixed-strings
      \ --ignore-case --hidden --follow --color "always"
      \ -g "!{.git,node_modules,vendor,build,dist}/*" '

    " use :F to search everything with ripgrep
    command! -bang -nargs=* F call fzf#vim#grep(g:rg_command .shellescape(<q-args>).'| tr -d "\017"', 1, <bang>0)
  " }

  " Prettier {
    "autocmd BufWritePre *.js,*.mjs,*.json,*.ts,*.tsx,*.vue,*.graphql,*.yaml,*.yml PrettierAsync
  " }

  " Tabular {
    if exists(":Tabularize")
      " align equal signs in normal and visual mode
      nmap <Leader>a= :Tabularize /=<CR>
      vmap <Leader>a= :Tabularize /=<CR>

      " align colons in normal and visual mode
      nmap <Leader>a: :Tabularize /:\zs<CR>
      vmap <Leader>a: :Tabularize /:\zs<CR>
    endif

    " use Tabularize when in insert mode and a | is typed
    " http://vimcasts.org/episodes/aligning-text-with-tabular-vim/
    inoremap <silent> <Bar>   <Bar><Esc>:call <SID>align()<CR>a

    function! s:align()
      let p = '^\s*|\s.*\s|\s*$'
      if exists(':Tabularize') && getline('.') =~# '^\s*|' && (getline(line('.')-1) =~# p || getline(line('.')+1) =~# p)
        let column = strlen(substitute(getline('.')[0:col('.')],'[^|]','','g'))
        let position = strlen(matchstr(getline('.')[0:col('.')],'.*|\s*\zs.*'))
        Tabularize/|/l1
        normal! 0
        call search(repeat('[^|]*|',column).'\s\{-\}'.repeat('.',position),'ce',line('.'))
      endif
    endfunction
  " }

  " Typescript Vim {
    " We force typescript as a file everywhere because Vim added typescriptreact
    " filetype, breaking detection for a whole bunch of plugins
    " https://github.com/vim/vim/issues/4830
    autocmd BufNewFile,BufRead *.tsx set filetype=typescript.tsx
  " }

  " Emmet {
  let g:user_emmet_settings = {
  \ 'indentation': '  ',
  \ 'javascript.jsx' : {
  \     'extends' : 'jsx',
  \ },
  \}
  " }

  " Editorconfig {
    let g:EditorConfig_exclude_patterns = ['fugitive://.\*']
  " }

  " Elm {
    let g:elm_syntastic_show_warnings = 1
    let g:elm_format_autosave = 1
  " }
" }
