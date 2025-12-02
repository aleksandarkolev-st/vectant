
export const CPP_STD_LIBS = {
    'iostream': [
        { label: 'cout', kind: 'Variable', detail: 'std::cout', insertText: 'std::cout' },
        { label: 'cin', kind: 'Variable', detail: 'std::cin', insertText: 'std::cin' },
        { label: 'endl', kind: 'Constant', detail: 'std::endl', insertText: 'std::endl' },
        { label: 'cerr', kind: 'Variable', detail: 'std::cerr', insertText: 'std::cerr' },
    ],
    'string': [
        { label: 'string', kind: 'Class', detail: 'std::string', insertText: 'std::string' },
        { label: 'to_string', kind: 'Function', detail: 'std::to_string', insertText: 'std::to_string(${1:val})', insertTextRules: 4 },
        { label: 'getline', kind: 'Function', detail: 'std::getline', insertText: 'std::getline(${1:cin}, ${2:str})', insertTextRules: 4 },
        { label: 'stoi', kind: 'Function', detail: 'std::stoi', insertText: 'std::stoi(${1:str})', insertTextRules: 4 },
    ],
    'vector': [
        { label: 'vector', kind: 'Class', detail: 'std::vector', insertText: 'std::vector<${1:T}>', insertTextRules: 4 },
    ],
    'map': [
        { label: 'map', kind: 'Class', detail: 'std::map', insertText: 'std::map<${1:Key}, ${2:Value}>', insertTextRules: 4 },
        { label: 'pair', kind: 'Class', detail: 'std::pair', insertText: 'std::pair<${1:T1}, ${2:T2}>', insertTextRules: 4 },
    ],
    'unordered_map': [
        { label: 'unordered_map', kind: 'Class', detail: 'std::unordered_map', insertText: 'std::unordered_map<${1:Key}, ${2:Value}>', insertTextRules: 4 },
    ],
    'set': [
        { label: 'set', kind: 'Class', detail: 'std::set', insertText: 'std::set<${1:T}>', insertTextRules: 4 },
    ],
    'algorithm': [
        { label: 'sort', kind: 'Function', detail: 'std::sort', insertText: 'std::sort(${1:begin}, ${2:end})', insertTextRules: 4 },
        { label: 'find', kind: 'Function', detail: 'std::find', insertText: 'std::find(${1:begin}, ${2:end}, ${3:val})', insertTextRules: 4 },
        { label: 'max', kind: 'Function', detail: 'std::max', insertText: 'std::max(${1:a}, ${2:b})', insertTextRules: 4 },
        { label: 'min', kind: 'Function', detail: 'std::min', insertText: 'std::min(${1:a}, ${2:b})', insertTextRules: 4 },
        { label: 'reverse', kind: 'Function', detail: 'std::reverse', insertText: 'std::reverse(${1:begin}, ${2:end})', insertTextRules: 4 },
    ],
    'cmath': [
        { label: 'sqrt', kind: 'Function', detail: 'std::sqrt', insertText: 'std::sqrt(${1:x})', insertTextRules: 4 },
        { label: 'pow', kind: 'Function', detail: 'std::pow', insertText: 'std::pow(${1:base}, ${2:exp})', insertTextRules: 4 },
        { label: 'abs', kind: 'Function', detail: 'std::abs', insertText: 'std::abs(${1:x})', insertTextRules: 4 },
        { label: 'ceil', kind: 'Function', detail: 'std::ceil', insertText: 'std::ceil(${1:x})', insertTextRules: 4 },
        { label: 'floor', kind: 'Function', detail: 'std::floor', insertText: 'std::floor(${1:x})', insertTextRules: 4 },
    ],
    'memory': [
        { label: 'shared_ptr', kind: 'Class', detail: 'std::shared_ptr', insertText: 'std::shared_ptr<${1:T}>', insertTextRules: 4 },
        { label: 'unique_ptr', kind: 'Class', detail: 'std::unique_ptr', insertText: 'std::unique_ptr<${1:T}>', insertTextRules: 4 },
        { label: 'make_shared', kind: 'Function', detail: 'std::make_shared', insertText: 'std::make_shared<${1:T}>(${2:args})', insertTextRules: 4 },
        { label: 'make_unique', kind: 'Function', detail: 'std::make_unique', insertText: 'std::make_unique<${1:T}>(${2:args})', insertTextRules: 4 },
    ]
};

export const COMMON_KEYWORDS = [
    'int', 'float', 'double', 'char', 'void', 'bool', 'auto',
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
    'return', 'break', 'continue', 'struct', 'class', 'public', 'private', 'protected',
    'namespace', 'using', 'template', 'typename', 'const', 'static', 'virtual', 'override',
    'new', 'delete', 'true', 'false', 'nullptr', 'this', 'friend', 'inline'
];
