/*
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

var logger = require('_pr/logger')(module);
var yml = require('json2yaml');
var uuid = require('node-uuid');
var appConfig = require('_pr/config');
var fileIo = require('_pr/lib/utils/fileio');
var fileUpload = require('_pr/model/file-upload/file-upload');
var noticeService = require('_pr/services/noticeService.js');
var scriptService = require('_pr/services/scriptService.js');
var async = require('async');
var masterUtil = require('_pr/lib/utils/masterUtil.js');
var targz = require('targz');
var fs = require('fs');
var request = require('request');
var path = require('path');
var mkdirp = require('mkdirp');
var SSHExec = require('_pr/lib/utils/sshexec');
var waitForPort = require('wait-for-port');
var monitorsModel = require('_pr/model/monitors/monitors.js');
var credentialCryptography = require('_pr/lib/credentialcryptography');
var instancesDao = require('_pr/model/classes/instance/instance');
var instanceLogModel = require('_pr/model/log-trail/instanceLog.js');
var logsDao = require('_pr/model/dao/logsdao.js');
var Chef = require('_pr/lib/chef');
var Docker = require('_pr/model/docker.js');
var instanceModel = require('_pr/model/resources/instance-resource');




const errorType = 'commonService';

var commonService = module.exports = {};

commonService.checkNodeCredentials = function checkNodeCredentials(credentials, nodeDetail, callback) {
    var openPort = 22;
    if (nodeDetail.nodeOs === 'windows') {
        openPort = 5985;
    }
    waitForPort(nodeDetail.nodeIp, openPort, function (err) {
        if (err) {
            logger.error(err);
            return callback(err, null);
        }else if (nodeDetail.nodeOs !== 'windows') {
            var sshOptions = {
                username: credentials.username,
                host: nodeDetail.nodeIp,
                port: 22
            }
            if (credentials.pemFileLocation) {
                sshOptions.privateKey = credentials.pemFileLocation;
                sshOptions.pemFileData = credentials.pemFileData;
            } else {
                sshOptions.password = credentials.password;
            }
            var sshExec = new SSHExec(sshOptions);
            sshExec.exec('echo Welcome', function (err, retCode) {
                if (err) {
                    callback(err, null);
                    return;
                } else if (retCode === 0) {
                    callback(null, true);
                } else {
                    callback(null, false);
                }
            }, function (stdOut) {
                logger.debug(stdOut.toString('ascii'));
            }, function (stdErr) {
                logger.error(stdErr.toString('ascii'));
            });
        }else {
            return callback(null, true);
        }
    })
}

commonService.getCredentialsFromReq = function getCredentialsFromReq(credentials,callback) {
    if (credentials.pemFileData) {
        credentials.pemFileLocation = appConfig.tempDir + uuid.v4();
        fileIo.writeFile(credentials.pemFileLocation, credentials.pemFileData, null, function (err) {
            if (err) {
                logger.error('unable to create pem file ', err);
                callback(err, null);
                return;
            }
            return callback(null, credentials);
        });
    } else {
        return callback(null, credentials);
    }
}



commonService.bootstrapInstance = function bootstrapInstance(resource,credentials,provider,envName,reqBody,serverDetails,callback){
    credentialCryptography.encryptCredential(credentials, function (err, encryptedCredentials) {
        if (err) {
            logger.error("unable to encrypt credentials", err);
            var err = new Error("Unable to encrypt credentials");
            err.status = 400;
            return callback(err, null);
        }
        var openPort = 22;
        if (resource.resourceDetails.os === 'windows') {
            openPort = 5985;
        }
        waitForPort(resource.resourceDetails.publicIp, openPort, function (err) {
            if (err) {
                logger.error(err);
                return callback(err, null);
            }
            var nodeDetails = {
                nodeIp: resource.resourceDetails.publicIp !== null ? resource.resourceDetails.publicIp : resource.resourceDetails.privateIp,
                nodeOs: resource.resourceDetails.os,
                nodeName: resource.resourceDetails.platformId,
                nodeEnv: envName
            }
            this.checkNodeCredentials(credentials, nodeDetails, function (err, credentialStatus) {
                if (err) {
                    logger.error(err);
                    var err = new Error("Invalid Credentials");
                    err.status = 400;
                    return callback(err, null);
                } else if (credentialStatus) {
                    monitorsModel.getById(reqBody.monitorId, function (err, monitor) {
                        var instance = {
                            name: resource.resourceDetails.platformId,
                            orgId: reqBody.orgId,
                            orgName: reqBody.orgName,
                            bgName: reqBody.bgName,
                            environmentName: envName,
                            bgId: reqBody.bgId,
                            projectId: reqBody.projectId,
                            projectName: reqBody.projectName,
                            envId: reqBody.envId,
                            tagServer: reqBody.tagServer,
                            providerId: provider._id,
                            providerType: 'aws',
                            providerData: {
                                region: resource.providerDetails.region.region
                            },
                            chefNodeName: resource.resourceDetails.platformId,
                            runlist: [],
                            platformId: resource.resourceDetails.platformId,
                            appUrls: appUrls,
                            instanceIP: resource.resourceDetails.publicIp,
                            instanceState: resource.resourceDetails.state,
                            network: resource.resourceDetails.network,
                            vpcId: resource.resourceDetails.vpcId,
                            privateIpAddress: resource.resourceDetails.privateIp,
                            hostName: resource.resourceDetails.hostName,
                            monitor: monitor,
                            bootStrapStatus: 'waiting',
                            hardware: {
                                platform: 'unknown',
                                platformVersion: 'unknown',
                                architecture: 'unknown',
                                memory: {
                                    total: 'unknown',
                                    free: 'unknown'
                                },
                                os: resource.resourceDetails.os
                            },
                            credentials: encryptedCredentials,
                            blueprintData: {
                                blueprintName: resource.resourceDetails.platformId,
                                templateId: "chef_import",
                                iconPath: "../private/img/templateicons/chef_import.png"
                            }
                        };
                        if (serverDetails.configType === 'chef') {
                            instance.chef = {
                                serverId: serverDetails.rowid,
                                chefNodeName: resource.resourceDetails.platformId
                            }
                        } else {
                            instance.puppet = {
                                serverId: serverDetails.rowid
                            }
                        }
                        instancesDao.createInstance(instance, function (err, data) {
                            if (err) {
                                logger.error('Unable to create Instance ', err);
                                return;
                            }
                            instance.id = data._id;
                            instance._id = data._id;
                            var timestampStarded = new Date().getTime();
                            var actionLog = instancesDao.insertBootstrapActionLog(instance.id, [], req.session.user.cn, timestampStarded);
                            logsDao.insertLog({
                                instanceId: instance._id,
                                instanceRefId: actionLog._id,
                                err: false,
                                log: "Bootstrapping instance",
                                timestamp: timestampStarded
                            });
                            var instanceLog = {
                                actionId: actionLog._id,
                                instanceId: instance.id,
                                orgName: reqBody.orgName,
                                bgName: reqBody.bgName,
                                projectName: reqBody.projectName,
                                envName: reqBody.environmentName,
                                status: resource.resourceDetails.state,
                                actionStatus: "waiting",
                                platformId: resource.resourceDetails.platformId,
                                blueprintName: resource.resourceDetails.platformId,
                                data: [],
                                platform: "unknown",
                                os: resource.resourceDetails.os,
                                size: "",
                                user: req.session.user.cn,
                                startedOn: new Date().getTime(),
                                createdOn: new Date().getTime(),
                                providerType: "aws",
                                action: "Imported From Provider"
                            };
                            instanceLogModel.createOrUpdate(actionLog._id, instance.id, instanceLog, function (err, logData) {
                                if (err) {
                                    logger.error("Failed to create or update instanceLog: ", err);
                                }
                            });
                            credentialCryptography.decryptCredential(encryptedCredentials, function (err, decryptedCredentials) {
                                if (err) {
                                    logger.error("unable to decrypt credentials", err);
                                    var timestampEnded = new Date().getTime();
                                    logsDao.insertLog({
                                        instanceId: instance._id,
                                        instanceRefId: actionLog._id,
                                        err: true,
                                        log: "Unable to decrypt credentials. Bootstrap Failed",
                                        timestamp: timestampEnded
                                    });
                                    instancesDao.updateActionLog(instance.id, actionLog._id, false, timestampEnded);
                                    instanceLog.endedOn = new Date().getTime();
                                    instanceLog.actionStatus = "failed";
                                    instanceLogModel.createOrUpdate(actionLog._id, instance.id, instanceLog, function (err, logData) {
                                        if (err) {
                                            logger.error("Failed to create or update instanceLog: ", err);
                                        }
                                    });
                                    return;
                                }
                                var infraManager;
                                var bootstrapOption;
                                var deleteOptions;
                                if (serverDetails.configType === 'chef') {
                                    logger.debug('In chef ');
                                    infraManager = new Chef({
                                        userChefRepoLocation: serverDetails.chefRepoLocation,
                                        chefUserName: serverDetails.loginname,
                                        chefUserPemFile: serverDetails.userpemfile,
                                        chefValidationPemFile: serverDetails.validatorpemfile,
                                        hostedChefUrl: serverDetails.url
                                    });
                                    bootstrapOption = {
                                        instanceIp: instance.instanceIP,
                                        pemFilePath: decryptedCredentials.pemFileLocation,
                                        instancePassword: decryptedCredentials.password,
                                        instanceUsername: instance.credentials.username,
                                        nodeName: instance.chef.chefNodeName,
                                        environment: envName,
                                        instanceOS: instance.hardware.os
                                    };
                                    if (instance.monitor && instance.monitor.parameters.transportProtocol === 'rabbitmq') {
                                        var sensuCookBooks = MasterUtils.getSensuCookbooks();
                                        var runlist = sensuCookBooks;
                                        var jsonAttributes = {};
                                        jsonAttributes['sensu-client'] = MasterUtils.getSensuCookbookAttributes(instance.monitor, instance.id);
                                        bootstrapOption['runlist'] = runlist;
                                        bootstrapOption['jsonAttributes'] = jsonAttributes;
                                    }
                                    deleteOptions = {
                                        privateKey: decryptedCredentials.pemFileLocation,
                                        username: decryptedCredentials.username,
                                        host: instance.instanceIP,
                                        instanceOS: instance.hardware.os,
                                        port: 22,
                                        cmds: ["rm -rf /etc/chef/", "rm -rf /var/chef/"],
                                        cmdswin: ["del "]
                                    }
                                    if (decryptedCredentials.pemFileLocation) {
                                        deleteOptions.privateKey = decryptedCredentials.pemFileLocation;
                                    } else {
                                        deleteOptions.password = decryptedCredentials.password;
                                    }
                                } else {
                                    var puppetSettings = {
                                        host: serverDetails.hostname,
                                        username: serverDetails.username,
                                    };
                                    if (serverDetails.pemFileLocation) {
                                        puppetSettings.pemFileLocation = serverDetails.pemFileLocation;
                                    } else {
                                        puppetSettings.password = serverDetails.puppetpassword;
                                    }
                                    logger.debug('puppet pemfile ==> ' + puppetSettings.pemFileLocation);
                                    bootstrapOption = {
                                        host: instance.instanceIP,
                                        username: instance.credentials.username,
                                        pemFileLocation: decryptedCredentials.pemFileLocation,
                                        password: decryptedCredentials.password,
                                        environment: envName
                                    };
                                    var deleteOptions = {
                                        username: decryptedCredentials.username,
                                        host: instance.instanceIP,
                                        port: 22,
                                    }
                                    if (decryptedCredentials.pemFileLocation) {
                                        deleteOptions.pemFileLocation = decryptedCredentials.pemFileLocation;
                                    } else {
                                        deleteOptions.password = decryptedCredentials.password;
                                    }
                                    infraManager = new Puppet(puppetSettings);
                                }
                                infraManager.cleanClient(deleteOptions, function (err, retCode) {
                                    logger.debug("Entering chef.bootstarp");
                                    infraManager.bootstrapInstance(bootstrapOption, function (err, code, bootstrapData) {
                                        if (err) {
                                            logger.error("knife launch err ==>", err);
                                            instancesDao.updateInstanceBootstrapStatus(instance.id, 'failed', function (err, updateData) {
                                                if (err) {
                                                    logger.error("Failed to update BootStrap Status: ", err);
                                                }
                                            });
                                            if (err.message) {
                                                var timestampEnded = new Date().getTime();
                                                logsDao.insertLog({
                                                    instanceId: instance._id,
                                                    instanceRefId: actionLog._id,
                                                    err: true,
                                                    log: err.message,
                                                    timestamp: timestampEnded
                                                });
                                                instanceLog.actionStatus = "failed";
                                                instanceLogModel.createOrUpdate(actionLog._id, instance.id, instanceLog, function (err, logData) {
                                                    if (err) {
                                                        logger.error("Failed to create or update instanceLog: ", err);
                                                    }
                                                });
                                            }else {
                                                var timestampEnded = new Date().getTime();
                                                logsDao.insertLog({
                                                    instanceId: instance._id,
                                                    instanceRefId: actionLog._id,
                                                    err: true,
                                                    log: "Bootstrap Failed",
                                                    timestamp: timestampEnded
                                                });
                                                instancesDao.updateActionLog(instance.id, actionLog._id, false, timestampEnded);
                                                instanceLog.actionStatus = "failed";
                                                instanceLog.endedOn = new Date().getTime();
                                                instanceLogModel.createOrUpdate(actionLog._id, instance.id, instanceLog, function (err, logData) {
                                                    if (err) {
                                                        logger.error("Failed to create or update instanceLog: ", err);
                                                    }
                                                });
                                            }
                                        } else {
                                            if (code == 0) {
                                                instancesDao.updateInstanceBootstrapStatus(instance.id, 'success', function (err, updateData) {
                                                    if (err) {
                                                        logger.error("Unable to set instance bootstarp status. code 0");
                                                    } else {
                                                        logger.debug("Instance bootstrap status set to success");
                                                    }
                                                });
                                                var nodeName;
                                                if (bootstrapData && bootstrapData.puppetNodeName) {
                                                    instancesDao.updateInstancePuppetNodeName(instance.id, bootstrapData.puppetNodeName, function (err, updateData) {
                                                        if (err) {
                                                            logger.error("Unable to set puppet node name");
                                                        } else {
                                                            logger.debug("puppet node name updated successfully");
                                                        }
                                                    });
                                                    nodeName = bootstrapData.puppetNodeName;
                                                } else {
                                                    nodeName = instance.chef.chefNodeName;
                                                }
                                                var timestampEnded = new Date().getTime();
                                                logsDao.insertLog({
                                                    instanceId: instance._id,
                                                    instanceRefId: actionLog._id,
                                                    err: false,
                                                    log: "Instance Bootstrapped Successfully",
                                                    timestamp: timestampEnded
                                                });
                                                instancesDao.updateActionLog(instance.id, actionLog._id, true, timestampEnded);
                                                instanceLog.actionStatus = "success";
                                                instanceLog.endedOn = new Date().getTime();
                                                instanceLogModel.createOrUpdate(actionLog._id, instance.id, instanceLog, function (err, logData) {
                                                    if (err) {
                                                        logger.error("Failed to create or update instanceLog: ", err);
                                                    }
                                                });
                                                var hardwareData = {};
                                                if (bootstrapData && bootstrapData.puppetNodeName) {
                                                    var runOptions = {
                                                        username: decryptedCredentials.username,
                                                        host: instance.instanceIP,
                                                        port: 22,
                                                    }
                                                    if (decryptedCredentials.pemFileLocation) {
                                                        runOptions.pemFileLocation = decryptedCredentials.pemFileLocation;
                                                    } else {
                                                        runOptions.password = decryptedCredentials.password;
                                                    }
                                                    infraManager.runClient(runOptions, function (err, retCode) {
                                                        if (decryptedCredentials.pemFileLocation) {
                                                            fileIo.removeFile(decryptedCredentials.pemFileLocation, function (err) {
                                                                if (err) {
                                                                    logger.debug("Unable to delete temp pem file =>", err);
                                                                } else {
                                                                    logger.debug("temp pem file deleted =>", err);
                                                                }
                                                            });
                                                        }
                                                        if (err) {
                                                            logger.error("Unable to run puppet client", err);
                                                            return;
                                                        }
                                                        setTimeout(function () {
                                                            infraManager.getNode(nodeName, function (err, nodeData) {
                                                                if (err) {
                                                                    logger.error(err);
                                                                    return;
                                                                }
                                                                instanceLog.platform = nodeData.facts.values.operatingsystem;
                                                                instanceLogModel.createOrUpdate(actionLog._id, instance.id, instanceLog, function (err, logData) {
                                                                    if (err) {
                                                                        logger.error("Failed to create or update instanceLog: ", err);
                                                                    }
                                                                });
                                                                hardwareData.architecture = nodeData.facts.values.hardwaremodel;
                                                                hardwareData.platform = nodeData.facts.values.operatingsystem;
                                                                hardwareData.platformVersion = nodeData.facts.values.operatingsystemrelease;
                                                                hardwareData.memory = {
                                                                    total: 'unknown',
                                                                    free: 'unknown'
                                                                };
                                                                hardwareData.memory.total = nodeData.facts.values.memorysize;
                                                                hardwareData.memory.free = nodeData.facts.values.memoryfree;
                                                                hardwareData.os = instance.hardware.os;
                                                                instancesDao.setHardwareDetails(instance.id, hardwareData, function (err, updateData) {
                                                                    if (err) {
                                                                        logger.error("Unable to set instance hardware details  code (setHardwareDetails)", err);
                                                                    } else {
                                                                        logger.debug("Instance hardware details set successessfully");
                                                                    }
                                                                });
                                                            });
                                                        }, 30000);
                                                    });

                                                } else {
                                                    infraManager.getNode(nodeName, function (err, nodeData) {
                                                        if (err) {
                                                            logger.error(err);
                                                            return;
                                                        }
                                                        instanceLog.platform = nodeData.automatic.platform;
                                                        instanceLogModel.createOrUpdate(actionLog._id, instance.id, instanceLog, function (err, logData) {
                                                            if (err) {
                                                                logger.error("Failed to create or update instanceLog: ", err);
                                                            }
                                                        });
                                                        hardwareData.architecture = nodeData.automatic.kernel.machine;
                                                        hardwareData.platform = nodeData.automatic.platform;
                                                        hardwareData.platformVersion = nodeData.automatic.platform_version;
                                                        hardwareData.memory = {
                                                            total: 'unknown',
                                                            free: 'unknown'
                                                        };
                                                        if (nodeData.automatic.memory) {
                                                            hardwareData.memory.total = nodeData.automatic.memory.total;
                                                            hardwareData.memory.free = nodeData.automatic.memory.free;
                                                        }
                                                        hardwareData.os = instance.hardware.os;
                                                        instancesDao.setHardwareDetails(instance.id, hardwareData, function (err, updateData) {
                                                            if (err) {
                                                                logger.error("Unable to set instance hardware details  code (setHardwareDetails)", err);
                                                            } else {
                                                                logger.debug("Instance hardware details set successessfully");
                                                            }
                                                        });
                                                        if (decryptedCredentials.pemFilePath) {
                                                            fileIo.removeFile(decryptedCredentials.pemFilePath, function (err) {
                                                                if (err) {
                                                                    logger.error("Unable to delete temp pem file =>", err);
                                                                } else {
                                                                    logger.debug("temp pem file deleted");
                                                                }
                                                            });
                                                        }
                                                    });
                                                }
                                                var _docker = new Docker();
                                                _docker.checkDockerStatus(instance.id, function (err, retCode) {
                                                    if (err) {
                                                        logger.error("Failed _docker.checkDockerStatus", err);
                                                        return;
                                                        //res.end('200');

                                                    }
                                                    logger.debug('Docker Check Returned:' + retCode);
                                                    if (retCode == '0') {
                                                        instancesDao.updateInstanceDockerStatus(instance.id, "success", '', function (data) {
                                                            logger.debug('Instance Docker Status set to Success');
                                                        });

                                                    }
                                                });

                                            } else {
                                                instancesDao.updateInstanceBootstrapStatus(instance.id, 'failed', function (err, updateData) {
                                                    if (err) {
                                                        logger.error("Unable to set instance bootstarp status code != 0");
                                                    } else {
                                                        logger.debug("Instance bootstrap status set to failed");
                                                    }
                                                });
                                                var timestampEnded = new Date().getTime();
                                                logsDao.insertLog({
                                                    instanceId: instance._id,
                                                    instanceRefId: actionLog._id,
                                                    err: true,
                                                    log: "Bootstrap Failed",
                                                    timestamp: timestampEnded
                                                });
                                                instancesDao.updateActionLog(instance.id, actionLog._id, false, timestampEnded);
                                                instanceLog.actionStatus = "failed";
                                                instanceLog.endedOn = new Date().getTime();
                                                instanceLogModel.createOrUpdate(actionLog._id, instance.id, instanceLog, function (err, logData) {
                                                    if (err) {
                                                        logger.error("Failed to create or update instanceLog: ", err);
                                                    }
                                                });
                                            }
                                        }

                                    }, function (stdOutData) {
                                        logsDao.insertLog({
                                            instanceId: instance._id,
                                            instanceRefId: actionLog._id,
                                            err: false,
                                            log: stdOutData.toString('ascii'),
                                            timestamp: new Date().getTime()
                                        });
                                    }, function (stdErrData) {
                                        logsDao.insertLog({
                                            instanceId: instance._id,
                                            instanceRefId: actionLog._id,
                                            err: true,
                                            log: stdErrData.toString('ascii'),
                                            timestamp: new Date().getTime()
                                        });
                                    });
                                });
                                callback(null, {code:200,message:"Instance Imported : " + resource.resourceDetails.platformId});
                            });
                        });
                    });
                } else {
                    var err = new Error("The username or password/pemfile you entered is incorrect " + resource.resourceDetails.platformId + ". Cannot sync this node.");
                    err.status = 400;
                    return;
                }
            });
        });
    });
}
commonService.convertJson2Yml = function convertJson2Yml(reqBody,callback) {
    var ymlText = '',scriptFileName = '',count = 0;
    var id = uuid.v4();
    var commonJson = {
        id: id.split("-")[0]+id.split("-")[1]+id.split("-")[2]+id.split("-")[3],
        name: reqBody.name,
        desc: reqBody.desc,
        action: reqBody.action,
        type: reqBody.type,
        functionality: reqBody.category,
        subType: reqBody.subType ? reqBody.subType : (reqBody.blueprintType ? reqBody.blueprintType : null),
        manualExecutionTime: parseInt(reqBody.standardTime),
        input: [],
        execution: [],
        output: {
            logs:[],
            msgs: {
                mail: '',
                text: ''
            }
        }
    }
    if (reqBody.filters) {
        commonJson.output.filters = reqBody.filters;
    }
    if (reqBody.messages) {
        commonJson.output.msgs = reqBody.messages;
    }
    if (reqBody.logs) {
        commonJson.output.logs = reqBody.logs;
    }
    if (reqBody.type === 'script') {
        commonJson.output.logs.push('stdout');
        commonJson.output.msgs.text = 'Script BOT has executed successfully on Node ${node}';
        commonJson.output.msgs.mail = 'Node: ${node}'
        for(var i = 0; i < reqBody.scriptDetails.length; i ++) {
            (function (scriptDetail) {
                scriptFileName = appConfig.botFactoryDir + 'local/Code/script_BOTs/' + commonJson.id;
                var scriptFolder = path.normalize(scriptFileName);
                mkdirp.sync(scriptFolder);
                scriptService.getScriptById(scriptDetail.scriptId, function (err, fileData) {
                    if (err) {
                        logger.error("Error in reading file: ", err);
                    } else {
                        scriptFileName = scriptFileName + '/' + fileData.fileName;
                        fileIo.writeFile(scriptFileName, fileData.file, null, function (err) {
                            if (err) {
                                logger.error("Error in Writing File:", err);
                            } else {
                                var params = '';
                                count++;
                                scriptDetail.scriptParameters.forEach(function (param) {
                                    commonJson.input.push({
                                        default: param.paramVal,
                                        type: param.paramType === "" ? "text" : param.paramType.toLowerCase(),
                                        label: param.paramDesc,
                                        name: param.paramDesc.toLowerCase().replace(/ /g,"_")
                                    })
                                    if(params === ''){
                                        params = '${' + param.paramDesc.toLowerCase().replace(/ /g,"_") + '}'
                                    }else{
                                        params = params + ' ${' + param.paramDesc.toLowerCase().replace(/ /g,"_") + '}'
                                    }
                                });
                                commonJson.execution.push({
                                    type: reqBody.scriptTypeName.toLowerCase(),
                                    os: reqBody.scriptTypeName === 'Bash' || reqBody.scriptTypeName === 'Python' ? "ubuntu" : "windows",
                                    stage: "Script",
                                    param: params,
                                    entrypoint: fileData.fileName
                                });
                                if(count ===reqBody.scriptDetails.length){
                                    ymlText = yml.stringify(commonJson);
                                    createYML();
                                }
                            }
                        });
                    }
                })
            })(reqBody.scriptDetails[i])
        }
    } else if (reqBody.type === 'jenkins') {
        commonJson.isParameterized = reqBody.isParameterized;
        commonJson.autoSync = reqBody.autoSyncFlag;
        commonJson.input.push(
            {
                default: reqBody.jenkinsServerId,
                type: 'list',
                label: 'Jenkins Server Name',
                name: 'jenkinsServerId'
            },
            {
                default: reqBody.jobName,
                type: 'text',
                label: 'Jenkins JOB Name',
                name: 'jenkinsJobName'
            },
            {
                default: reqBody.jobURL,
                type: 'text',
                label: 'Jenkins JOB URL',
                name: 'jenkinsJobURL'
            }
        )
        if (reqBody.isParameterized === true) {
            commonJson.input.push({
                default: reqBody.parameterized,
                type: 'list',
                label: 'Jenkins JOB Parameters',
                name: 'jenkinsJobParameters'
            })
            commonJson.execution.push({
                type: reqBody.type,
                param: "${jenkinsJobName} ${jenkinsServerId} ${jenkinsJobURL} ${jenkinsJobParameters}",
                entrypoint: reqBody.jobName,
                parameterized: reqBody.parameterized
            })
        } else {
            commonJson.execution.push({
                type: reqBody.type,
                param: "${jenkinsJobName} ${jenkinsServerId} ${jenkinsJobURL}",
                entrypoint: reqBody.jobName,
                jenkinsServerName: reqBody.jenkinsServerName
            })
        }
        commonJson.output.msgs.text = '${jenkinsJobName} job has successfully built on ${jenkinsServerName}';
        commonJson.output.msgs.mail = 'JenkinsJobName: ${jenkinsJobName} JenkinsServerName: ${jenkinsServerName}'
        ymlText = yml.stringify(commonJson);
        createYML();
    } else if (reqBody.type === 'chef') {
        if (reqBody.attributes && (reqBody.attributes !== null || reqBody.attributes.length > 0)) {
            var attributeObj = {}, jsonObjKey = '';
            reqBody.attributes.forEach(function (attribute) {
                if (Object.keys(attributeObj).length === 0) {
                    attributeObj = attribute.jsonObj;
                    jsonObjKey = Object.keys(attribute.jsonObj)[0];
                    var attrValObj = attribute.jsonObj[Object.keys(attribute.jsonObj)[0]];
                    var key = Object.keys(attrValObj)[0];
                    attributeObj[jsonObjKey][key] = '${' + key + '}';
                } else {
                    var attrValObj = attribute.jsonObj[Object.keys(attribute.jsonObj)[0]];
                    var key = Object.keys(attrValObj)[0];
                    attributeObj[jsonObjKey][key] = '${' + key + '}';
                }
                commonJson.input.push({
                    default: attrValObj[key],
                    type: 'text',
                    label: attribute.name,
                    name: key
                })
            });
            commonJson.execution.push({
                type: 'cookBook',
                os: reqBody.os ? reqBody.os : 'ubuntu',
                attributes: attributeObj,
                param: "${runlist} ${attributes}",
                runlist: reqBody.runlist,
                stage: reqBody.name
            })
        } else {
            commonJson.execution.push({
                type: 'cookBook',
                os: reqBody.os,
                attributes: null,
                param: "${runlist}",
                runlist: reqBody.runlist,
                stage: reqBody.name
            })
        }
        commonJson.output.logs.push('stdout');
        commonJson.output.msgs.text = 'Cookbook RunList ${runlist} has executed successful on Node ${node}';
        commonJson.output.msgs.mail = 'RunList: ${runlist} Node: ${node}'
        ymlText = yml.stringify(commonJson);
        createYML();
    } else if (reqBody.type === 'blueprints' || reqBody.type === 'blueprint') {
        if (reqBody.subType === 'aws_cf' || reqBody.subType === 'azure_arm') {
            commonJson.input.push(
                {
                    default: reqBody.stackName ? reqBody.stackName : null,
                    type: 'text',
                    label: 'Stack Name',
                    name: 'stackName'
                })
        } else {
            commonJson.input.push(
                {
                    default: reqBody.domainName ? reqBody.domainName : null,
                    type: 'text',
                    label: 'Domain Name',
                    name: 'domainName'
                })
        }
        commonJson.input.push(
            {
                default: reqBody.blueprintIds ? reqBody.blueprintIds : [],
                type: 'list',
                label: 'Blueprint Name',
                name: 'blueprintIds'
            },
            {
                default: reqBody.envId ? reqBody.envId : [],
                type: 'list',
                label: 'Environment Name',
                name: 'envId'
            },
            {
                default: reqBody.monitorId ? reqBody.monitorId : [],
                type: 'list',
                label: 'Monitor Name',
                name: 'monitorId'
            },
            {
                default: reqBody.tagServer ? reqBody.tagServer : [],
                type: 'list',
                label: 'Tag Server',
                name: 'tagServer'
            }
        )
        commonJson.execution.push({
            type: reqBody.type,
            name: reqBody.blueprintName,
            id: reqBody.blueprintId,
            category: getBlueprintType(reqBody.blueprintType)
        })
        commonJson.output.logs.push('stdout');
        commonJson.output.msgs.text = '${blueprintName} has successfully launched on env ${envId}';
        commonJson.output.msgs.mail = 'BlueprintName: ${blueprintName} EnvName: ${envId}';
        ymlText = yml.stringify(commonJson);
        createYML();
    }
    function createYML() {
        commonJson.category = reqBody.category;
        commonJson.orgId = reqBody.orgId;
        commonJson.orgName = reqBody.orgName;
        commonJson.source = "Catalyst";
        var ymlFolderName = appConfig.botFactoryDir + 'local/YAML';
        var ymlFileName = commonJson.id + '.yaml'
        var ymlFolder = path.normalize(ymlFolderName);
        mkdirp.sync(ymlFolder);
        async.waterfall([
            function (next) {
                fileIo.writeFile(ymlFolder + '/' + ymlFileName, ymlText, null, next);
            },
            function (next) {
                fileUpload.uploadFile(commonJson.id + '.yaml', ymlFolder + '/' + ymlFileName, null, next);
            }
        ], function (err, results) {
            if (err) {
                logger.error(err);
                callback(err, null);
                fileIo.removeFile(ymlFolder + '/' + ymlFileName, function (err, removeCheck) {
                    if (err) {
                        logger.error(err);
                    }
                    logger.debug("Successfully remove YML file");
                })
                fileIo.removeFile(scriptFileName, function (err, removeCheck) {if (err) {
                    logger.error(err);
                }
                    logger.debug("Successfully remove Script file");
                })
                return;
            } else {
                commonJson.ymlDocFileId = results;
                callback(null, commonJson);
                uploadFilesOnBotEngine(reqBody.orgId, function (err, data) {
                    if (err) {
                        logger.error("Error in uploading files at Bot Engine:", err);
                    }
                    return;
                })
            }
        });
    }
}

commonService.syncChefNodeWithResources = function syncChefNodeWithResources(chefNodeDetails,masterDetails,callback){
    async.parallel({
        instanceSchema: function(callback) {
            monitorsModel.getById(masterDetails.monitorId, function (err, monitor) {
                var instance = {
                    name: chefNodeDetails.name,
                    orgId: masterDetails.orgId,
                    bgId: masterDetails.bgId,
                    projectId: masterDetails.projectId,
                    envId: masterDetails.envId,
                    orgName: masterDetails.orgName,
                    bgName: masterDetails.bgName,
                    projectName: masterDetails.projectName,
                    environmentName: masterDetails.envName,
                    chefNodeName: chefNodeDetails.name,
                    runlist: chefNodeDetails.run_list,
                    platformId: chefNodeDetails.platformId,
                    instanceIP: chefNodeDetails.ip,
                    instanceState: 'running',
                    bootStrapStatus: 'success',
                    hardware: chefNodeDetails.hardware,
                    tagServer: masterDetails.tagServer,
                    monitor: monitor,
                    user: masterDetails.userName,
                    chef: {
                        serverId: chefNodeDetails.serverId,
                        chefNodeName: chefNodeDetails.name
                    },
                    source: 'chef',
                    blueprintData: {
                        blueprintName: chefNodeDetails.name,
                        templateId: "chef_import",
                        iconPath: "../private/img/templateicons/chef_import.png"
                    }
                };
                instancesDao.createInstance(instance, function (err, data) {
                    if (err) {
                        logger.debug(err, 'occured in inserting node in mongo');
                        callback(err, null);
                        return;
                    }
                    instance.id = data._id;
                    instance._id = data._id;
                    var timestampStarted = new Date().getTime();
                    var actionLog = instancesDao.insertBootstrapActionLogForChef(instance.id, [], masterDetails.userName, timestampStarted);
                    logsDao.insertLog({
                        instanceId: instance._id,
                        instanceRefId: actionLog._id,
                        err: false,
                        log: "Node Imported",
                        timestamp: timestampStarted
                    });
                    var instanceLog = {
                        actionId: actionLog._id,
                        instanceId: instance.id,
                        orgName: masterDetails.orgName,
                        bgName: masterDetails.bgName,
                        projectName: masterDetails.projectName,
                        envName: masterDetails.envName,
                        status: "running",
                        bootStrap: "success",
                        actionStatus: "success",
                        platformId: chefNodeDetails.platformId,
                        blueprintName: chefNodeDetails.name,
                        data: chefNodeDetails.run_list,
                        platform: chefNodeDetails.hardware.platform,
                        os: chefNodeDetails.hardware.os,
                        size: "",
                        user: masterDetails.userName,
                        startedOn: new Date().getTime(),
                        createdOn: new Date().getTime(),
                        providerType: "",
                        action: "Imported From ChefServer"
                    };

                    instanceLogModel.createOrUpdate(actionLog._id, instance.id, instanceLog, function (err, logData) {
                        if (err) {
                            logger.error("Failed to create or update instanceLog: ", err);
                        }
                        callback(null,data);
                        return;
                    });
                })
            })
        },
        resourceSchema: function(callback){
            var resourceObj = {
                name:chefNodeDetails.name,
                category:'managed',
                resourceType:chefNodeDetails.platformId && chefNodeDetails.platformId !== null ? 'EC2':'Instance',
                masterDetails: {
                    orgId: masterDetails.orgId,
                    orgName: masterDetails.orgName,
                    bgId: masterDetails.bgId,
                    bgName: masterDetails.bgName,
                    projectId: masterDetails.projectId,
                    projectName: masterDetails.projectName,
                    envId: masterDetails.envId,
                    envName: masterDetails.environmentName
                },
                resourceDetails:{
                    platformId:chefNodeDetails.platformId && chefNodeDetails.platformId !== null ? chefNodeDetails.platformId:chefNodeDetails.name,
                    publicIp:chefNodeDetails.ip,
                    privateIp:chefNodeDetails.ip,
                    state:'authentication_error',
                    bootStrapStatus:'success',
                    hardware:chefNodeDetails.hardware,
                    hostName:chefNodeDetails.fqdn
                },
                chefServerDetails:{
                    id:chefNodeDetails.serverId,
                    nodeName:chefNodeDetails.name,
                    run_list:chefNodeDetails.run_list
                },
                tagServer:masterDetails.tagServer?masterDetails.tagServer:null,
                monitor:masterDetails.monitor?masterDetails.monitor:null,
                blueprintData: {
                    blueprintName: chefNodeDetails.name,
                    templateName: "chef_import",
                }
            }
            resourceObj.createdOn = new Date().getTime();
            instanceModel.createNew(resourceObj,function(err,data){
                if(err){
                    logger.error("Error in creating Resources>>>>:",err);
                    return callback(err,null);
                }else{
                    return callback(null,data);
                }
            })

        }
    },function(err,results){
        if(err){
            return callback(err,null);
        }else{
            return callback(null,results.resourceSchema);
        }

    })
}

function getBlueprintType(type){
    var blueprintType = '';
    switch(type) {
        case 'chef':
            blueprintType ="Software Stack";
            break;
        case 'ami':
            blueprintType ="OS Image";
            break;
        case 'docker':
            blueprintType ="Docker";
            break;
        case 'arm':
            blueprintType ="ARM Template";
            break;
        case 'cft':
            blueprintType ="Cloud Formation";
            break;
        default:
            blueprintType ="Software Stack";
            break
    }
    return blueprintType;
}

function uploadFilesOnBotEngine(orgId,callback){
    async.waterfall([
        function (next) {
            var botRemoteServerDetails = {}
            masterUtil.getBotRemoteServerDetailByOrgId(orgId, function (err, botServerDetails) {
                if (err) {
                    logger.error("Error while fetching BOTs Server Details");
                    next(err, null);
                    return;
                } else if (botServerDetails !== null) {
                    botRemoteServerDetails.hostIP = botServerDetails.hostIP;
                    botRemoteServerDetails.hostPort = botServerDetails.hostPort;
                    next(null, botRemoteServerDetails);
                } else {
                    var error = new Error();
                    error.message = 'BOTs Remote Engine is not configured or not in running mode';
                    error.status = 403;
                    next(error, null);
                }
            });
        },
        function (botRemoteServerDetails, next) {
            var uploadCompress = appConfig.botFactoryDir + 'upload_compress.tar.gz';
            var upload = appConfig.botFactoryDir+'local';
            targz.compress({
                src: upload,
                dest: uploadCompress
            }, function (err) {
                if (err) {
                    next(err, null);
                } else {
                    var options = {
                        url: "http://" + botRemoteServerDetails.hostIP + ":" + botRemoteServerDetails.hostPort + "/bot/factory/upload",
                        headers: {
                            'Content-Type': 'multipart/form-data'
                        },
                        formData: {
                            file: {
                                value: fs.readFileSync(uploadCompress),
                                options: {
                                    filename: uploadCompress,
                                    contentType: 'application/tar+gzip'
                                }
                            }
                        }
                    };
                    request.post(options, function (err, res, data) {
                        next(err, res)
                        fs.unlinkSync(uploadCompress);
                    });
                }
            });
        }
    ], function (err, res) {
        if (err) {
            logger.error("Unable to connect remote server");
            callback(err,null);
        }else{
            callback(null,null);
            return;
        }
    });

}


