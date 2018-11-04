/*jshint esversion: 6 */

class TensorFlowLiteModelFactory {


    match(context, host) {
        var extension = context.identifier.split('.').pop();
        return extension == 'tflite' || extension == 'lite';
    }

    open(context, host, callback) {
        host.require('tflite-schema', (err) => {
            if (err) {
                callback(err, null);
                return;
            }

            var model = null;
            try {
                var buffer = context.buffer;
                var byteBuffer = new flatbuffers.ByteBuffer(buffer);
                if (!tflite.Model.bufferHasIdentifier(byteBuffer))
                {
                    var identifier = (buffer && buffer.length >= 8 && buffer.slice(4, 8).every((c) => c >= 32 && c <= 127)) ? String.fromCharCode.apply(null, buffer.slice(4, 8)) : '';
                    callback(new TensorFlowLiteError("Invalid FlatBuffers identifier '" + identifier + "' in '" + context.identifier + "'."));
                    return;
                }
                model = tflite.Model.getRootAsModel(byteBuffer);
            }
            catch (error) {
                host.exception(error, false);
                callback(new TensorFlowLiteError(error.message), null);
            }

            TensorFlowLiteOperatorMetadata.open(host, (err, metadata) => {
                try {
                    callback(null, new TensorFlowLiteModel(model));
                }
                catch (error) {
                    host.exception(error, false);
                    callback(new TensorFlowLiteError(error.message), null);
                }
            });
        });
    }
}

class TensorFlowLiteModel {

    constructor(model) {
        this._graphs = [];
        this._format = 'TensorFlow Lite v' + model.version().toString();
        var description = model.description();
        this._description = (description && description.length > 0) ? description : null;
        var operatorCodeList = [];
        var builtinOperatorMap = {};
        Object.keys(tflite.BuiltinOperator).forEach(function (key) {
            var upperCase = { '2D': true, 'LSH': true, 'SVDF': true, 'RNN': true, 'L2': true, 'LSTM': true };
            var builtinOperatorIndex = tflite.BuiltinOperator[key]; 
            builtinOperatorMap[builtinOperatorIndex] = key.split('_').map((s) => {
                return (s.length < 1 || upperCase[s]) ? s : s.substring(0, 1) + s.substring(1).toLowerCase();
            }).join('');
        });
        for (var operatorIndex = 0; operatorIndex < model.operatorCodesLength(); operatorIndex++) {
            var operatorCode = model.operatorCodes(operatorIndex);
            var builtinCode = operatorCode.builtinCode();
            operatorCodeList.push((builtinCode == tflite.BuiltinOperator.CUSTOM) ? operatorCode.customCode() : builtinOperatorMap[builtinCode]);
        }
        var subgraphsLength = model.subgraphsLength();
        for (var subgraph = 0; subgraph < subgraphsLength; subgraph++) {
            var name = (subgraphsLength > 1) ? ('(' + subgraph.toString() + ')') : '';
            this._graphs.push(new TensorFlowLiteGraph(model.subgraphs(subgraph), name, operatorCodeList, model));
        }
    }

    get format() {
        return this._format;
    }

    get description() {
        return this._description;
    }

    get graphs() {
        return this._graphs;
    }
} 

class TensorFlowLiteGraph {

    constructor(graph, name, operatorCodeList, model) {
        this._graph = graph;
        this._name = this._graph.name() || name;
        this._nodes = [];
        this._inputs = [];
        this._outputs = [];
        this._operators = {};
        var connections = [];
        var names = [];
        for (var i = 0; i < graph.tensorsLength(); i++) {
            var tensor = graph.tensors(i);
            var initializer = null;
            var buffer = model.buffers(tensor.buffer());
            if (buffer.dataLength() > 0) {
                initializer = new TensorFlowLiteTensor(tensor, i, buffer);
            }
            connections.push(new TensorFlowLiteConnection(tensor, i, initializer));
            names.push(tensor.name());
        }
        for (var j = 0; j < this._graph.operatorsLength(); j++) {
            var operator = this._graph.operators(j);
            var opcodeIndex = operator.opcodeIndex();
            var operatorName = (opcodeIndex < operatorCodeList.length) ? operatorCodeList[opcodeIndex] : ('(' + opcodeIndex.toString() + ')');
            var node = new TensorFlowLiteNode(operator, operatorName, connections);
            this._operators[node.operator] = (this._operators[node.operator] || 0) + 1;
            this._nodes.push(node);
        }
        for (var k = 0; k < graph.inputsLength(); k++) {
            var inputIndex = graph.inputs(k);
            this._inputs.push(new TensorFlowLiteArgument(names[inputIndex], true, [ connections[inputIndex] ]));
        }
        for (var l = 0; l < graph.outputsLength(); l++) {
            var outputIndex = graph.outputs(l);
            this._outputs.push(new TensorFlowLiteArgument(names[outputIndex], true, [ connections[outputIndex] ]));
        }
    }

    get operators() {
        return this._operators;
    }

    get name() {
        return this._name;
    }

    get groups() {
        return false;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get nodes() {
        return this._nodes;
    }
}

class TensorFlowLiteNode {

    constructor(node, operator, connections) {
        this._operator = operator;

        var inputs = TensorFlowLiteOperatorMetadata.operatorMetadata.getInputs(node, this.operator);
        this._inputs = inputs.map((input) => {
            return new TensorFlowLiteArgument(input.name, input.visible != false, input.connections.map((connection) => {
                return connections[connection.id];
            }));
        });
        this._outputs = [];
        for (var i = 0; i < node.outputsLength(); i++) {
            var index = node.outputs(i);
            var connection = connections[index];
            var name = TensorFlowLiteOperatorMetadata.operatorMetadata.getOutputName(this.operator, i);
            this._outputs.push(new TensorFlowLiteArgument(name, true, [ connection ]));
        }

        this._attributes = [];
        var metadata = TensorFlowLiteOperatorMetadata.operatorMetadata;
        var optionsTypeName = 'tflite.' + this._operator + 'Options';
        var optionsType = TensorFlowLiteNode._getType(optionsTypeName);
        if (typeof optionsType === 'function') {
            var options = Reflect.construct(optionsType, []);
            node.builtinOptions(options);
            var attributeNames = [];
            var attributeNamesMap = {};
            Object.keys(Object.getPrototypeOf(options)).forEach((attributeName) => {
                if (attributeName != '__init') {
                    attributeNames.push(attributeName);
                }
                attributeNamesMap[attributeName] = true;
            });
            var attributeArrayNamesMap = {}; 
            Object.keys(attributeNamesMap).forEach((attributeName) => {
                if (attributeNamesMap[attributeName + 'Array'] && attributeNamesMap[attributeName + 'Length']) {
                    attributeArrayNamesMap[attributeName] = true;
                    attributeNames = attributeNames.filter((item) => item != (attributeName + 'Array') && item != (attributeName + 'Length'));
                }
            });
            attributeNames.forEach((name) => {
                if (options[name] && typeof options[name] == 'function') {
                    var value = null;
                    if (attributeArrayNamesMap[name]) {
                        var array = [];
                        var length = options[name + 'Length']();
                        var a = options[name + 'Array']();
                        for (var i = 0; i < length; i++) {
                            array.push(a[i]);
                        }
                        value = () => '[' + array.join(', ') + ']';
                    }
                    else {
                        value = options[name]();
                    }
                    this._attributes.push(new TensorFlowLiteAttribute(metadata, operator, name, value));
                }
            });
        }
    }

    get operator() {
        return this._operator;
    }

    get name() {
        return null;
    }

    get domain() {
        return null;
    }

    get primitive() {
        return null;
    }

    get documentation() {
        return null;
    }

    get group() {
        return null;
    }

    get category() {
        var schema = TensorFlowLiteOperatorMetadata.operatorMetadata.getSchema(this.operator);
        return (schema && schema.category) ? schema.category : null;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get dependencies() {
        return [];
    }

    get attributes() {
        return this._attributes;
    }

    static _getType(name) {
        var list = name.split('.');
        var type = window;
        while (list.length > 0) {
            var item = list.shift();
            type = type[item];
            if (!type) {
                return null;
            }
        }
        if (type == window) {
            return null;
        }
        return type;
    }
}

class TensorFlowLiteAttribute {

    constructor(metadata, operator, name, value) {
        this._type = null;
        this._value = value;
        this._name = '';
        var lower = name.toLowerCase();
        for (var i = 0; i < name.length; i++) {
            this._name += (name[i] == lower[i]) ? name[i] : ('_' + lower[i]);
        }
    
        var schema = metadata.getAttributeSchema(operator, this._name);
        if (schema) {
            if (schema.type) {
                this._type = schema.type;
            }
            if (this._type && tflite) {
                var type = tflite[this._type];
                if (type && type[this.value]) {
                    this._value = type[this.value];
                }
            }
            if (schema.hasOwnProperty('visible') && !schema.visible) {
                this._visible = false;
            }
            else if (schema.hasOwnProperty('default')) {
                value = this._value;
                if (typeof value == 'function') {
                    value = value();
                }
                if (value == schema.default) {
                    this._visible = false;
                }
            }
        }
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get value() {
        return this._value;
    }

    get visible() {
        return this._visible == false ? false : true;
    }
}

class TensorFlowLiteArgument {
    constructor(name, visible, connections) {
        this._name = name;
        this._visible = visible;
        this._connections = connections;
    }

    get name() {
        return this._name;
    }

    get visible() {
        return this._visible;
    }

    get connections() {
        return this._connections;
    }
}

class TensorFlowLiteConnection {

    constructor(tensor, index, initializer) {
        this._id = tensor.name() || index.toString();
        this._type = initializer ? null : new TensorFlowLiteTensorType(tensor);
        this._initializer = initializer;
        var quantization = tensor.quantization();
        if (quantization) {
            var value = 'q';
            var scale = (quantization.scaleLength() == 1) ? quantization.scale(0) : 0;
            var zeroPoint = (quantization.zeroPointLength() == 1) ? quantization.zeroPoint(0).toFloat64() : 0;
            if (scale != 0 || zeroPoint != 0) {
                value = scale.toString() + ' * ' + (zeroPoint == 0 ? 'q' : ('(q - ' + zeroPoint.toString() + ')'));
            }
            if (quantization.minLength() == 1) {
                value = quantization.min(0).toString() + ' \u2264 ' + value;
            }
            if (quantization.maxLength() == 1) {
                value = value + ' \u2264 ' + quantization.max(0).toString();
            }
            if (value != 'q') {
                this._quantization = value;
            }
        }
    }

    get id() {
        if (this._initializer) {
            return this._initializer.name;
        }
        return this._id;
    }

    get type() {
        if (this._initializer) {
            return this._initializer.type;
        }
        return this._type;
    }

    get quantization() {
        return this._quantization;
    }

    get initializer() {
        return this._initializer;
    }
}

class TensorFlowLiteTensor {

    constructor(tensor, index, buffer) {
        this._id = index;
        this._name = tensor.name();
        this._type = new TensorFlowLiteTensorType(tensor);
        this._data = buffer.dataLength() > 0 ? buffer.dataArray() : null;
    }

    get id() {
        return this._id.toString();
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get state() {
        return this._context().state;
    }

    get value() {
        var context = this._context();
        if (context.state) {
            return null;
        }
        context.limit = Number.MAX_SAFE_INTEGER;
        return this._decode(context, 0);
    }

    toString() {
        var context = this._context();
        if (context.state) {
            return '';
        }
        context.limit = 10000;
        var value = this._decode(context, 0);
        return JSON.stringify(value, null, 4);
    }

    _context() {
        var context = {};
        context.state = null;
        context.index = 0;
        context.count = 0;

        if (this._data == null) {
            context.state = 'Tensor data is empty.';
            return context;
        }
 
        context.dataType = this._type.dataType;
        context.dimensions = this._type.shape.dimensions;
        context.data = new DataView(this._data.buffer, this._data.byteOffset, this._data.byteLength);

        if (this._type.dataType == 'string') {
            var utf8Decoder = window.TextDecoder ? new TextDecoder('utf-8') : null;
            var offset = 0;
            var count = context.data.getInt32(0, true);
            offset += 4;
            var offsetTable = [];
            for (var j = 0; j < count; j++) {
                offsetTable.push(context.data.getInt32(offset, true));
                offset += 4;
            }
            offsetTable.push(this._data.length);
            var stringTable = [];
            for (var k = 0; k < count; k++) {
                var textArray = this._data.subarray(offsetTable[k], offsetTable[k + 1]);
                if (utf8Decoder) {
                    stringTable.push(utf8Decoder.decode(textArray));
                }
                else {
                    stringTable.push(String.fromCharCode.apply(null, textArray));
                }
            }
            context.data = stringTable;
        }
        return context;
    }

    _decode(context, dimension) {
        var size = context.dimensions[dimension];
        var results = [];
        if (dimension == context.dimensions.length - 1) {
            for (var i = 0; i < size; i++) {
                if (context.count > context.limit) {
                    results.push('...');
                    return results;
                }
                switch (context.dataType)
                {
                    case 'uint8':
                        results.push(context.data.getUint8(context.index));
                        context.index += 1;
                        context.count++;
                        break;
                    case 'int32':
                        results.push(context.data.getInt32(context.index, true));
                        context.index += 4;
                        context.count++;
                        break;
                    case 'int64':
                        results.push(new Int64(context.data.getInt64(context.index, true)));
                        context.index += 8;
                        context.count++;
                        break;
                    case 'float16':
                        results.push(context.data.getFloat16(context.index, true));
                        context.index += 2;
                        context.count++;
                        break;
                    case 'float32':
                        results.push(context.data.getFloat32(context.index, true));
                        context.index += 4;
                        context.count++;
                        break;
                    case 'string':
                        results.push(context.data[context.index++]);
                        context.count++;
                        break;
                    default:
                        break;
                }
            }
        }
        else {
            for (var j = 0; j < size; j++) {
                if (context.count > context.limit) {
                    results.push('...');
                    return results;
                }
                results.push(this._decode(context, dimension + 1));
            }
        }
        return results;
    }
}

class TensorFlowLiteTensorType {

    constructor(tensor) {
        var dataType = tflite.TensorType[tensor.type()]; 
        this._dataType = (dataType) ? dataType.toLowerCase() : '?';
        this._shape = new TensorFlowLiteTensorShape(tensor);
    }

    get dataType() {
        return this._dataType;
    }

    get shape() {
        return this._shape;
    }

    toString() {
        return this.dataType + this._shape.toString();
    }
}

class TensorFlowLiteTensorShape {

    constructor(tensor) {
        this._dimensions = [];
        var shapeLength = tensor.shapeLength();
        if (shapeLength > 0) {
            for (var i = 0; i < shapeLength; i++) {
                this._dimensions.push(tensor.shape(i));
            }
        }
    }

    get dimensions() {
        return this._dimensions;
    }

    toString() {
        return this._dimensions ? ('[' + this._dimensions.map((dimension) => dimension.toString()).join(',') + ']') : '';
    }
}

class TensorFlowLiteOperatorMetadata {

    static open(host, callback) {
        if (TensorFlowLiteOperatorMetadata.operatorMetadata) {
            callback(null, TensorFlowLiteOperatorMetadata.operatorMetadata);
        }
        else {
            host.request(null, 'tflite-metadata.json', 'utf-8', (err, data) => {
                TensorFlowLiteOperatorMetadata.operatorMetadata = new TensorFlowLiteOperatorMetadata(data);
                callback(null, TensorFlowLiteOperatorMetadata.operatorMetadata);
            });    
        }
    }

    constructor(data) {
        this._map = {};
        if (data) {
            var items = JSON.parse(data);
            if (items) {
                items.forEach((item) => {
                    if (item.name && item.schema)
                    {
                        this._map[item.name] = item.schema;
                    }
                });
            }
        }
    }

    getSchema(operator) {
        return this._map[operator];
    }

    getInputs(node, operator) {
        var results = [];
        var connections = [];
        for (var i = 0; i < node.inputsLength(); i++) {
            connections.push(node.inputs(i));
        }
        var schema = this.getSchema(operator);
        var index = 0;
        while (index < connections.length) {
            var result = { connections: [] };
            var count = 1;
            var name = null;
            if (schema && schema.inputs && index < schema.inputs.length) {
                var input = schema.inputs[index];
                name = input.name;
                if (input.option == 'variadic') {
                    count = connections.length - index;
                }
                if (input.hasOwnProperty('visible') && !input.visible) {
                    result.visible = false;
                }
            }
            result.name = name ? name : '(' + index.toString() + ')';
            var array = connections.slice(index, index + count);
            for (var j = 0; j < array.length; j++) {
                if (array[j] != -1) {
                    result.connections.push({ id: array[j] });
                }
            }
            index += count;
            results.push(result);
        }
        return results;
    }

    getOutputName(operator, index) {
        var schema = this.getSchema(operator);
        if (schema) {
            var outputs = schema.outputs;
            if (outputs && index < outputs.length) {
                var output = outputs[index];
                if (output) {
                    if (!output.option || output.option != 'variadic') {
                        var name = output.name;
                        if (name) {
                            return name;
                        }
                    }
                } 
            }
        }
        return '(' + index.toString() + ')';
    }

    getAttributeSchema(operator, name) {
        var schema = this.getSchema(operator);
        if (schema) {
            var attributeMap = schema.attributeMap;
            if (!attributeMap) {
                attributeMap = {};
                if (schema.attributes) {
                    schema.attributes.forEach((attribute) => {
                        attributeMap[attribute.name] = attribute;
                    });
                }
                schema.attributeMap = attributeMap;
            }
            var attributeSchema = attributeMap[name];
            if (attributeSchema) {
                return attributeSchema; 
            }
        }
        return null;
    }
}

class TensorFlowLiteError extends Error {
    constructor(message) {
        super(message);
        this.name = 'Error loading TensorFlow Lite model.';
    }
}
